package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import ai.apilens.HeartbeatStub.Reply;
import ai.apilens.internal.HttpClients;
import ai.apilens.resources.DataSourcePools;
import ai.apilens.resources.DefaultCollectors;
import ai.apilens.resources.Fs;
import ai.apilens.resources.IdentityResolver;
import ai.apilens.resources.ResourceSampler;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The heartbeat's {@code resources} and {@code identity} blocks against the contract (M7). */
class ResourcesHeartbeatTest {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Path TESTDATA = Path.of("..", "..", "testdata");
  private static final Path GOLDEN = TESTDATA.resolve("resources/heartbeat_v1.json");

  /** A Linux container tree: the v2 fixture cgroup plus procfs for the SDK process and its parent. */
  static Path linuxRoot(Path tmp) throws IOException {
    Path source = TESTDATA.resolve("cgroup/v2_namespaced_limited/root");
    Path root = tmp.resolve("root");
    try (Stream<Path> paths = Files.walk(source)) {
      for (Path path : paths.sorted(Comparator.naturalOrder()).toList()) {
        Path dest = root.resolve(source.relativize(path).toString());
        if (Files.isDirectory(path)) {
          Files.createDirectories(dest);
        } else {
          Files.copy(path, dest);
        }
      }
    }
    Path self = root.resolve("proc/self");
    Files.writeString(self.resolve("status"), "Name:\tjava\nVmRSS:\t204800 kB\nThreads:\t31\nCpus_allowed_list:\t0-7\n");
    Files.createDirectories(self.resolve("fd"));
    Files.writeString(self.resolve("fd/0"), "");
    Files.writeString(self.resolve("smaps_rollup"), "Pss: 1024 kB\nPrivate_Clean: 10 kB\nPrivate_Dirty: 500 kB\n");
    Path init = root.resolve("proc/1");
    Files.createDirectories(init);
    Files.writeString(init.resolve("cgroup"), "0::/\n");
    Files.writeString(init.resolve("comm"), "java\n");
    Files.writeString(init.resolve("stat"), "1 (java) S 0 1 1 0 -1 0 0 0 0 0 120 30 0 0 20 0 31 0 1 0 51200");
    Files.writeString(init.resolve("status"), "VmRSS:\t204800 kB\n");
    Files.writeString(init.resolve("cmdline"), "java\0-Dpassword=s3cr3t\0");
    return root;
  }

  private static ApiLensClient client(HeartbeatStub stub, Consumer<ApiLensConfig.Builder> mutator) {
    ApiLensConfig.Builder builder = ApiLensConfig.builder()
        .apiKey("test-key")
        .appId("orders-api")
        .baseUrl(stub.baseUrl())
        .sendMetadata(false);
    mutator.accept(builder);
    ApiLensConfig config = builder.build();
    ApiLensClient client = new ApiLensClient(config, HttpClients.create(config), null, false);
    client.identityResolver = IdentityResolver.of(Map.of(
        "KUBERNETES_SERVICE_HOST", "10.0.0.1", "POD_NAME", "orders-7d9c8b6f5-x2k4q", "POD_NAMESPACE", "shop",
        "NODE_NAME", "node-a"), TESTDATA.resolve("cgroup/v2_namespaced_limited/root"), "orders-7d9c8b6f5-x2k4q",
        Instant.parse("2026-11-25T08:00:00Z"));
    return client;
  }

  private static ResourceSampler fakeLinuxSampler(Path root) {
    return new ResourceSampler(Duration.ofSeconds(15), DefaultCollectors.create(Fs.at(root), new DataSourcePools(), true));
  }

  @Test
  void heartbeatResourcesMatchTheGoldenFixtureAndTheIngestContract(@TempDir Path tmp) throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    Path root = linuxRoot(tmp);
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, b -> {});
      ResourceSampler sampler = fakeLinuxSampler(root);
      client.useResourceSampler(sampler);
      try {
        sampler.sampleNow();
        Files.writeString(root.resolve("sys/fs/cgroup/cpu.stat"),
            "usage_usec 126456789\nnr_periods 1100\nnr_throttled 205\nthrottled_usec 2600000\n");
        Thread.sleep(20);
        sampler.sampleNow();
        assertTrue(client.sendHeartbeat());
        JsonNode body = stub.heartbeats().get(0).body();
        assertEquals(List.of(), IngestContract.heartbeatViolations(body));
        JsonNode resources = body.get("resources");
        assertEquals(1, resources.get("v").asInt());
        assertEquals(2, resources.get("n").asInt());
        assertEquals("cgroup_v2", resources.get("limit_source").asText());
        Set<String> caps = new TreeSet<>();
        resources.get("capabilities").forEach(c -> caps.add(c.asText()));
        assertTrue(caps.containsAll(Set.of("process.memory", "process.pss", "container.cpu", "container.memory",
            "runtime.jvm", "processes")), caps.toString());

        // Every non-JVM path we send exists in the golden fixture (runtime.jvm is checked by
        // the closed OpenAPI schema above, the fixture being a Python process).
        JsonNode golden = MAPPER.readTree(GOLDEN.toFile()).get("resources");
        Set<String> missing = new TreeSet<>();
        for (String path : paths(resources, "")) {
          if (!path.startsWith("runtime.jvm") && !hasPath(golden, path)) {
            missing.add(path);
          }
        }
        assertEquals(Set.of(), missing, "paths not in heartbeat_v1.json");
        assertEquals(0.25, resources.at("/container/cpu/throttled_ratio").asDouble(), 1e-9);
        assertEquals(209715200L, resources.at("/process/memory/rss/last").asLong());
        assertEquals("3f4e9c2b1a0d8e7f6c5b4a3928170f6e5d4c3b2a1908f7e6d5c4b3a291807f6e",
            resources.at("/container/container_id").asText());
        assertFalse(body.toString().contains("s3cr3t"), "argv never sent");
        assertTrue(resources.at("/runtime/jvm/heap_used/last").asLong() > 0);

        JsonNode identity = body.get("identity");
        assertEquals("k8s", identity.get("platform").asText());
        assertEquals("orders-7d9c8b6f5-x2k4q", identity.get("pod_name").asText());
        assertFalse(identity.get("hostname_guess").asBoolean());
        assertEquals("2026-11-25T08:00:00Z", identity.get("process_start_time").asText());

        // The window was drained: a heartbeat with no new sample carries no block.
        assertTrue(client.sendHeartbeat());
        assertFalse(stub.heartbeats().get(1).body().has("resources"));
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void theGoldenFixtureItselfPassesTheContract() throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    // (heartbeat_v1_minimal.json uses explicit nulls, which this schema subset cannot express.)
    for (String name : List.of("heartbeat_v1.json")) {
      JsonNode fixture = MAPPER.readTree(TESTDATA.resolve("resources").resolve(name).toFile());
      assertEquals(List.of(), IngestContract.heartbeatViolations(fixture), name);
    }
  }

  @Test
  void theRealSamplerOnThisMachineMatchesTheContract() throws Exception {
    assumeTrue(IngestContract.available(), "OpenAPI document not in this checkout");
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, b -> {});
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15),
          DefaultCollectors.create(Fs.system(), new DataSourcePools(), true));
      client.useResourceSampler(sampler);
      try {
        sampler.sampleNow();
        Thread.sleep(20);
        sampler.sampleNow();
        assertTrue(client.sendHeartbeat());
        JsonNode body = stub.heartbeats().get(0).body();
        assertEquals(List.of(), IngestContract.heartbeatViolations(body));
        assertNotNull(body.at("/resources/process/cpu/cores_used/last"), body.toString());
        assertTrue(body.toString().getBytes().length < 32 * 1024);
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void captureResourcesOffStartsNoThreadAndSendsNoBlock() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensConfig config = ApiLensConfig.builder().apiKey("test-key").appId("orders-api").baseUrl(stub.baseUrl())
          .sendMetadata(false).captureResources(false).build();
      ApiLensClient client = new ApiLensClient(config);
      try {
        assertNull(client.resourceSampler());
        assertTrue(HeartbeatStub.await(() -> !stub.heartbeats().isEmpty(), Duration.ofSeconds(5)));
        assertFalse(stub.heartbeats().get(0).body().has("resources"));
        assertTrue(Thread.getAllStackTraces().keySet().stream()
            .noneMatch(t -> t.getName().equals("apilens-resources") && t.isAlive()
                && client.resourceSampler() != null));
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void aStartedClientSamplesOnItsDaemonThread() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensConfig config = ApiLensConfig.builder().apiKey("test-key").appId("orders-api").baseUrl(stub.baseUrl())
          .sendMetadata(false).build();
      ApiLensClient client = new ApiLensClient(config);
      try {
        assertNotNull(client.resourceSampler());
        assertTrue(client.resourceSampler().running());
        assertEquals(Duration.ofSeconds(15), client.resourceSampler().effectiveInterval());
      } finally {
        client.shutdown(false);
      }
      assertNull(client.resourceSampler(), "stopped with the client");
    }
  }

  @Test
  void theRemotePolicyNarrowsSampling(@TempDir Path tmp) throws Exception {
    Path root = linuxRoot(tmp);
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      RemotePolicy narrow = new RemotePolicy(true, 1.0, true, true, true, null,
          new RemotePolicy.Resources(true, 120, Set.of("processes", "runtime")));
      RemotePolicy off = new RemotePolicy(true, 1.0, true, true, true, null,
          new RemotePolicy.Resources(false, 15, Set.of()));
      stub.heartbeatReplies(Reply.ok(HeartbeatStub.policy(narrow)), Reply.ok(HeartbeatStub.policy(off)));
      ApiLensClient client = client(stub, b -> {});
      ResourceSampler sampler = fakeLinuxSampler(root);
      client.useResourceSampler(sampler);
      try {
        assertTrue(client.sendHeartbeat());
        assertEquals(narrow, client.remotePolicy());
        assertEquals(Duration.ofSeconds(120), sampler.effectiveInterval());
        sampler.sampleNow();
        assertTrue(client.sendHeartbeat());
        JsonNode resources = stub.heartbeats().get(1).body().get("resources");
        assertFalse(resources.has("runtime"), resources.toString());
        assertFalse(resources.has("processes"));
        assertTrue(resources.has("container"));
        sampler.sampleNow(); // policy off now: nothing sampled
        assertTrue(client.sendHeartbeat());
        assertFalse(stub.heartbeats().get(2).body().has("resources"));
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void requestRecordsCarryTheInstanceId() throws Exception {
    try (HeartbeatStub stub = HeartbeatStub.start()) {
      ApiLensClient client = client(stub, b -> b.sendHeartbeat(false).compress(false));
      client.capture(RequestRecord.builder().method("GET").path("/orders/1").statusCode(200).build());
      client.flushAll();
      JsonNode record = stub.requests().get(0).body().get("requests").get(0);
      assertEquals(client.instanceId(), record.get("instance_id").asText());
    }
  }

  // ---- JSON paths ------------------------------------------------------------

  /** Dotted leaf paths of {@code node}; arrays contribute their items' paths with {@code []}. */
  static Set<String> paths(JsonNode node, String prefix) {
    Set<String> out = new TreeSet<>();
    if (node.isObject()) {
      Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
      while (fields.hasNext()) {
        Map.Entry<String, JsonNode> field = fields.next();
        String path = prefix.isEmpty() ? field.getKey() : prefix + "." + field.getKey();
        if (field.getValue().isContainerNode() && field.getValue().size() > 0) {
          out.addAll(paths(field.getValue(), path));
        } else {
          out.add(path);
        }
      }
    } else if (node.isArray()) {
      for (JsonNode item : node) {
        if (item.isContainerNode()) {
          out.addAll(paths(item, prefix + "[]"));
        } else {
          out.add(prefix + "[]");
        }
      }
    }
    return out;
  }

  static boolean hasPath(JsonNode golden, String path) {
    return paths(golden, "").contains(path) || paths(golden, "").stream().anyMatch(p -> p.startsWith(path + "."))
        || golden.has(path);
  }
}
