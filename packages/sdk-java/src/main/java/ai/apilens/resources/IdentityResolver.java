package ai.apilens.resources;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the SDK process runs: the heartbeat's {@code identity}, resolved once per process.
 * Sources, in order: Downward API environment variables, well-known files (service-account
 * namespace, cgroup, mountinfo, DMI), the platform's own variables, and the hostname as a last
 * guess ({@code hostname_guess=true}). On ECS one metadata fetch (1 s, off the request path)
 * adds the container id and region.
 */
public final class IdentityResolver {
  static final String NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
  static final Duration ECS_TIMEOUT = Duration.ofSeconds(1);
  private static final Pattern POD_UID = Pattern.compile(
      "pod([0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12})");
  private static final Pattern KUBELET_POD_UID = Pattern.compile(
      "/kubelet/pods/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/");
  private static final List<String> VM_VENDORS = List.of(
      "qemu", "kvm", "vmware", "virtualbox", "xen", "amazon ec2", "google", "microsoft corporation",
      "digitalocean", "openstack", "hetzner", "parallels", "bochs", "oracle corporation", "linode", "vultr");
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final List<String> KEYS = List.of("hostname", "hostname_guess", "container_id", "pod_name",
      "pod_uid", "namespace", "node_name", "platform", "region", "process_start_time");

  private final Function<String, String> env;
  private final Fs fs;
  private final Supplier<String> hostnameFallback;
  private final Supplier<Instant> processStart;

  IdentityResolver(Function<String, String> env, Fs fs, Supplier<String> hostnameFallback, Supplier<Instant> processStart) {
    this.env = env;
    this.fs = fs;
    this.hostnameFallback = hostnameFallback;
    this.processStart = processStart;
  }

  private static final IdentityResolver SYSTEM = new IdentityResolver(System::getenv, Fs.system(),
      IdentityResolver::localHostName, () -> Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime()));

  private volatile Map<String, Object> cached;

  /** The real environment, filesystem and JVM start time; one per process. */
  public static IdentityResolver system() {
    return SYSTEM;
  }

  /** A resolver over a fixed environment and a fake filesystem root (tests, examples). */
  public static IdentityResolver of(Map<String, String> env, java.nio.file.Path root, String hostname, Instant start) {
    Map<String, String> copy = Map.copyOf(env);
    return new IdentityResolver(copy::get, Fs.at(root), () -> hostname, () -> start);
  }

  /** The OS hostname; bounded to 1 s because a misconfigured resolver can stall it for long. */
  private static String localHostName() {
    CompletableFuture<String> lookup = CompletableFuture.supplyAsync(() -> {
      try {
        return InetAddress.getLocalHost().getHostName();
      } catch (Exception ex) {
        return null;
      }
    });
    try {
      return lookup.get(1, TimeUnit.SECONDS);
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
      return null;
    } catch (Exception ex) {
      return null;
    }
  }

  /**
   * The identity, resolved on the first call (with the ECS metadata fetch through {@code http}
   * when on ECS) and cached for the life of the process.
   */
  public Map<String, Object> identity(HttpClient http) {
    Map<String, Object> out = cached;
    if (out == null) {
      synchronized (this) {
        out = cached;
        if (out == null) {
          try {
            out = Map.copyOf(withEcsMetadata(resolve(), http));
          } catch (RuntimeException ex) {
            out = Map.of();
          }
          // Map.copyOf loses the documented order; keep it.
          out = ordered(out);
          cached = out;
        }
      }
    }
    return out;
  }

  private static Map<String, Object> ordered(Map<String, Object> in) {
    Map<String, Object> ordered = new LinkedHashMap<>();
    for (String key : KEYS) {
      if (in.containsKey(key)) {
        ordered.put(key, in.get(key));
      }
    }
    return java.util.Collections.unmodifiableMap(ordered);
  }

  /** The identity without any network call. */
  public Map<String, Object> resolve() {
    String hostname = first(env("HOSTNAME"), fs.firstLine(fs.path("/etc/hostname")),
        fs.firstLine(fs.path("/proc/sys/kernel/hostname")), env("COMPUTERNAME"));
    if (hostname == null) {
      hostname = clean(hostnameFallback.get());
    }
    String podName = first(env("POD_NAME"), env("K8S_POD_NAME"), env("KUBERNETES_POD_NAME"));
    String namespace = first(env("POD_NAMESPACE"), env("K8S_NAMESPACE"), env("K8S_POD_NAMESPACE"),
        fs.firstLine(fs.path(NAMESPACE_FILE)));
    boolean k8s = env("KUBERNETES_SERVICE_HOST") != null || podName != null || namespace != null;
    String platform = platform(k8s);
    List<String> cgroupLines = fs.lines("/proc/self/cgroup");
    List<String> mountLines = fs.lines("/proc/self/mountinfo");
    String containerId = ContainerIds.fromCgroup(cgroupLines);
    if (containerId == null) {
      containerId = ContainerIds.fromMountinfo(mountLines);
    }
    String podUid = first(env("POD_UID"), env("K8S_POD_UID"));
    if (podUid == null && k8s) {
      podUid = podUid(cgroupLines, mountLines);
    }

    Map<String, Object> out = new LinkedHashMap<>();
    put(out, "hostname", hostname);
    out.put("hostname_guess", podName == null);
    put(out, "container_id", containerId);
    put(out, "pod_name", podName != null ? podName : k8s ? hostname : null);
    if (k8s) {
      put(out, "pod_uid", podUid);
      put(out, "namespace", namespace);
      put(out, "node_name", first(env("NODE_NAME"), env("K8S_NODE_NAME"), env("KUBE_NODE_NAME")));
    }
    put(out, "platform", platform);
    put(out, "region", first(env("AWS_REGION"), env("AWS_DEFAULT_REGION"), env("FLY_REGION")));
    Instant start = processStart.get();
    if (start != null) {
      out.put("process_start_time", Instant.ofEpochMilli(start.toEpochMilli()).toString());
    }
    return out;
  }

  private String platform(boolean k8s) {
    if (k8s) {
      return "k8s";
    }
    if (env("ECS_CONTAINER_METADATA_URI_V4") != null || env("ECS_CONTAINER_METADATA_URI") != null) {
      return "ecs";
    }
    if (env("AWS_LAMBDA_FUNCTION_NAME") != null) {
      return "lambda";
    }
    if (env("K_SERVICE") != null && env("K_REVISION") != null) {
      return "cloud_run";
    }
    if (env("GAE_SERVICE") != null || env("GAE_APPLICATION") != null) {
      return "app_engine";
    }
    if (env("DYNO") != null) {
      return "heroku";
    }
    if (env("FLY_APP_NAME") != null || env("FLY_ALLOC_ID") != null) {
      return "fly";
    }
    String vendor = (first(fs.firstLine(fs.path("/sys/class/dmi/id/sys_vendor")), "") + " "
        + first(fs.firstLine(fs.path("/sys/class/dmi/id/product_name")), "")).toLowerCase(Locale.ROOT);
    for (String v : VM_VENDORS) {
      if (vendor.contains(v)) {
        return "vm";
      }
    }
    if (fs.firstLine(fs.path("/sys/hypervisor/type")) != null) {
      return "vm";
    }
    return "bare";
  }

  private static String podUid(List<String> cgroupLines, List<String> mountLines) {
    for (String line : cgroupLines) {
      Matcher m = POD_UID.matcher(line);
      if (m.find()) {
        return m.group(1).replace('_', '-');
      }
    }
    for (String line : mountLines) {
      Matcher m = KUBELET_POD_UID.matcher(line);
      if (m.find()) {
        return m.group(1);
      }
    }
    return null;
  }

  /**
   * Adds what the ECS task metadata endpoint knows (container id, region) to {@code identity}.
   * One GET through {@code http}, bounded to {@link #ECS_TIMEOUT}; any failure leaves the
   * identity as it was.
   */
  public Map<String, Object> withEcsMetadata(Map<String, Object> identity, HttpClient http) {
    String uri = first(env("ECS_CONTAINER_METADATA_URI_V4"), env("ECS_CONTAINER_METADATA_URI"));
    if (uri == null || http == null) {
      return identity;
    }
    CompletableFuture<HttpResponse<String>> call = null;
    try {
      HttpRequest request = HttpRequest.newBuilder(URI.create(uri)).timeout(ECS_TIMEOUT).GET().build();
      call = http.sendAsync(request, HttpResponse.BodyHandlers.ofString());
      HttpResponse<String> response = call.get(ECS_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
      if (response.statusCode() != 200) {
        return identity;
      }
      return mergeEcs(identity, MAPPER.readTree(response.body()));
    } catch (InterruptedException ex) {
      Thread.currentThread().interrupt();
      return identity;
    } catch (Exception ex) {
      return identity;
    } finally {
      if (call != null) {
        call.cancel(true);
      }
    }
  }

  /** {@code identity} plus the container id and region of an ECS container metadata document. */
  static Map<String, Object> mergeEcs(Map<String, Object> identity, JsonNode metadata) {
    Map<String, Object> out = new LinkedHashMap<>(identity);
    String dockerId = metadata.path("DockerId").asText("");
    if (!dockerId.isBlank()) {
      out.put("container_id", dockerId.trim());
    }
    String arn = metadata.path("Labels").path("com.amazonaws.ecs.task-arn").asText("");
    String[] parts = arn.split(":");
    if (!out.containsKey("region") && parts.length > 3 && !parts[3].isBlank()) {
      out.put("region", parts[3]);
    }
    out.put("platform", "ecs");
    return ordered(out);
  }

  private String env(String name) {
    return clean(env.apply(name));
  }

  private static void put(Map<String, Object> out, String key, String value) {
    if (value != null) {
      out.put(key, value.length() > 253 ? value.substring(0, 253) : value);
    }
  }

  private static String clean(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }

  private static String first(String... values) {
    for (String value : values) {
      String clean = clean(value);
      if (clean != null) {
        return clean;
      }
    }
    return null;
  }
}
