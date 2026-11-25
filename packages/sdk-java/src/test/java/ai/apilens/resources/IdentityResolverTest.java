package ai.apilens.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Identity per platform: Downward API env, well-known files, platform variables, hostname guess. */
class IdentityResolverTest {
  private static final Instant START = Instant.parse("2026-11-25T08:00:00Z");
  private static final String ID = "3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e";

  private static Map<String, Object> resolve(Map<String, String> env, Path root) {
    return IdentityResolver.of(env, root, "fallback-host", START).identity(HttpClient.newHttpClient());
  }

  private static Map<String, Object> expected(Object... pairs) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) {
      out.put((String) pairs[i], pairs[i + 1]);
    }
    out.put("process_start_time", "2026-11-25T08:00:00Z");
    return out;
  }

  @Test
  void kubernetesWithTheDownwardApi() {
    Map<String, Object> got = resolve(Map.of(
        "HOSTNAME", "storefront-7d9c8b6f5-x2k4q",
        "KUBERNETES_SERVICE_HOST", "10.0.0.1",
        "POD_NAME", "storefront-7d9c8b6f5-x2k4q",
        "POD_NAMESPACE", "shop",
        "POD_UID", "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
        "NODE_NAME", "gke-prod-pool-1-a1b2c3"), CgroupReaderTest.CGROUP.resolve("v2_k8s_nested/root"));
    assertEquals(expected(
        "hostname", "storefront-7d9c8b6f5-x2k4q", "hostname_guess", false, "container_id", ID,
        "pod_name", "storefront-7d9c8b6f5-x2k4q", "pod_uid", "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b",
        "namespace", "shop", "node_name", "gke-prod-pool-1-a1b2c3", "platform", "k8s"), got);
    assertEquals(List.copyOf(got.keySet()), List.of("hostname", "hostname_guess", "container_id", "pod_name",
        "pod_uid", "namespace", "node_name", "platform", "process_start_time"), "documented order");
  }

  @Test
  void kubernetesWithoutTheDownwardApiGuessesFromTheHostnameAndFiles(@TempDir Path tmp) throws Exception {
    Path root = CgroupReaderTest.copy("v2_namespaced_limited", tmp);
    Files.createDirectories(root.resolve("var/run/secrets/kubernetes.io/serviceaccount"));
    Files.writeString(root.resolve("var/run/secrets/kubernetes.io/serviceaccount/namespace"), "shop");
    Files.createDirectories(root.resolve("etc"));
    Files.writeString(root.resolve("etc/hostname"), "storefront-abc\n");
    Map<String, Object> got = resolve(Map.of("KUBERNETES_SERVICE_HOST", "10.0.0.1"), root);
    // cgroup v2 with a namespace: the container id and pod uid come from mountinfo.
    assertEquals(expected(
        "hostname", "storefront-abc", "hostname_guess", true, "container_id", ID, "pod_name", "storefront-abc",
        "pod_uid", "8a6f1c2e-4b3d-4e5f-9a8b-7c6d5e4f3a2b", "namespace", "shop", "platform", "k8s"), got);
  }

  @Test
  void dockerOnALaptopIsBareWithAContainerId() {
    Map<String, Object> got = resolve(Map.of(), CgroupReaderTest.CGROUP.resolve("v1_docker/root"));
    assertEquals(expected("hostname", "fallback-host", "hostname_guess", true, "container_id", ID, "platform", "bare"), got);
  }

  @Test
  void platformsFromTheirVariables(@TempDir Path empty) {
    Map<Map<String, String>, Map<String, Object>> matrix = new LinkedHashMap<>();
    matrix.put(Map.of("ECS_CONTAINER_METADATA_URI_V4", "http://127.0.0.1:9/v4", "AWS_REGION", "us-west-2"),
        expected("hostname", "fallback-host", "hostname_guess", true, "platform", "ecs", "region", "us-west-2"));
    matrix.put(Map.of("AWS_LAMBDA_FUNCTION_NAME", "fn", "AWS_REGION", "eu-west-1"),
        expected("hostname", "fallback-host", "hostname_guess", true, "platform", "lambda", "region", "eu-west-1"));
    matrix.put(Map.of("K_SERVICE", "api", "K_REVISION", "api-00001"),
        expected("hostname", "fallback-host", "hostname_guess", true, "platform", "cloud_run"));
    matrix.put(Map.of("GAE_SERVICE", "default"),
        expected("hostname", "fallback-host", "hostname_guess", true, "platform", "app_engine"));
    matrix.put(Map.of("DYNO", "web.1", "HOSTNAME", "d1b2"),
        expected("hostname", "d1b2", "hostname_guess", true, "platform", "heroku"));
    matrix.put(Map.of("FLY_APP_NAME", "api", "FLY_REGION", "ams"),
        expected("hostname", "fallback-host", "hostname_guess", true, "platform", "fly", "region", "ams"));
    matrix.put(Map.of(), expected("hostname", "fallback-host", "hostname_guess", true, "platform", "bare"));
    matrix.forEach((env, want) -> {
      Map<String, String> withoutNetwork = new HashMap<>(env);
      // Platform detection only: the ECS fetch is covered below.
      IdentityResolver resolver = IdentityResolver.of(withoutNetwork, empty, "fallback-host", START);
      assertEquals(want, resolver.resolve(), env.toString());
    });
  }

  @Test
  void aVmFromDmi(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("sys/class/dmi/id"));
    Files.writeString(root.resolve("sys/class/dmi/id/sys_vendor"), "Google\n");
    assertEquals("vm", resolve(Map.of(), root).get("platform"));
  }

  @Test
  void ecsMetadataAddsTheContainerIdAndRegion(@TempDir Path empty) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v4", exchange -> {
      byte[] body = ("{\"DockerId\":\"5a0d5ceddf6c44c1928d367a815d890f-1234567890\",\"Labels\":"
          + "{\"com.amazonaws.ecs.task-arn\":\"arn:aws:ecs:eu-central-1:123456789012:task/c/5a0d\"}}")
          .getBytes(StandardCharsets.UTF_8);
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    });
    server.start();
    try {
      String uri = "http://127.0.0.1:" + server.getAddress().getPort() + "/v4";
      Map<String, Object> got = resolve(Map.of("ECS_CONTAINER_METADATA_URI_V4", uri), empty);
      assertEquals(expected("hostname", "fallback-host", "hostname_guess", true,
          "container_id", "5a0d5ceddf6c44c1928d367a815d890f-1234567890", "platform", "ecs",
          "region", "eu-central-1"), got);
    } finally {
      server.stop(0);
    }
  }

  @Test
  void ecsMetadataFailureIsSilentAndBoundedToOneSecond(@TempDir Path empty) throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/v4", exchange -> {
      try {
        Thread.sleep(2_500);
      } catch (InterruptedException ex) {
        Thread.currentThread().interrupt();
      }
      exchange.close();
    });
    server.start();
    try {
      String uri = "http://127.0.0.1:" + server.getAddress().getPort() + "/v4";
      long start = System.nanoTime();
      Map<String, Object> got = resolve(Map.of("ECS_CONTAINER_METADATA_URI_V4", uri), empty);
      Duration took = Duration.ofNanos(System.nanoTime() - start);
      assertTrue(took.compareTo(Duration.ofMillis(2_500)) < 0, "bounded: " + took);
      assertEquals("ecs", got.get("platform"));
      assertFalse(got.containsKey("container_id"));
      // Unreachable endpoint: same, no exception.
      assertEquals("ecs", resolve(Map.of("ECS_CONTAINER_METADATA_URI_V4", "http://127.0.0.1:9/v4"), empty).get("platform"));
    } finally {
      server.stop(0);
    }
  }

  @Test
  void resolvedOncePerResolver(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("etc"));
    Files.writeString(root.resolve("etc/hostname"), "first\n");
    IdentityResolver resolver = IdentityResolver.of(Map.of(), root, null, START);
    assertEquals("first", resolver.identity(null).get("hostname"));
    Files.writeString(root.resolve("etc/hostname"), "second\n");
    assertEquals("first", resolver.identity(null).get("hostname"));
  }
}
