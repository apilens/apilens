package ai.apilens;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.zip.GZIPInputStream;

/**
 * Local ingest stub for heartbeat and metadata tests. Every POST is recorded with its arrival
 * time. {@code /heartbeat} answers the next scripted reply (the last one repeats; by default the
 * capture-everything policy), {@code /metadata} the next scripted metadata reply (then 200), and
 * every other path 202.
 */
public final class HeartbeatStub implements AutoCloseable {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** A scripted response. */
  public record Reply(int status, Map<String, String> headers, String body) {
    public static Reply ok(String body) {
      return new Reply(200, Map.of(), body);
    }

    public static Reply status(int status) {
      return new Reply(status, Map.of(), "{\"error\":\"stub\",\"detail\":\"scripted\"}");
    }
  }

  /** One received POST. */
  public record Received(String path, Map<String, String> headers, JsonNode body, long atNanos) {}

  private final HttpServer server;
  private final List<Reply> heartbeatReplies = new ArrayList<>();
  private final List<Reply> metadataReplies = new ArrayList<>();
  private final List<Received> received = new ArrayList<>();
  private int heartbeatsAnswered;

  private HeartbeatStub(HttpServer server) {
    this.server = server;
  }

  public static HeartbeatStub start() throws IOException {
    HttpServer http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    HeartbeatStub stub = new HeartbeatStub(http);
    http.createContext("/", exchange -> {
      String path = exchange.getRequestURI().getPath();
      byte[] raw = exchange.getRequestBody().readAllBytes();
      String encoding = exchange.getRequestHeaders().getFirst("Content-Encoding");
      if ("gzip".equalsIgnoreCase(encoding)) {
        raw = new GZIPInputStream(new ByteArrayInputStream(raw)).readAllBytes();
      }
      Map<String, String> headers = new LinkedHashMap<>();
      exchange.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(), String.join(",", values)));
      JsonNode body;
      try {
        body = MAPPER.readTree(raw);
      } catch (IOException ex) {
        body = MAPPER.getNodeFactory().textNode(new String(raw, StandardCharsets.UTF_8));
      }
      Reply reply;
      synchronized (stub) {
        stub.received.add(new Received(path, headers, body, System.nanoTime()));
        if (path.endsWith("/heartbeat")) {
          reply = stub.heartbeatReplies.isEmpty()
              ? Reply.ok(policy(RemotePolicy.CAPTURE_EVERYTHING))
              : stub.heartbeatReplies.get(Math.min(stub.heartbeatsAnswered, stub.heartbeatReplies.size() - 1));
          stub.heartbeatsAnswered += 1;
        } else if (path.endsWith("/metadata")) {
          reply = stub.metadataReplies.isEmpty()
              ? Reply.ok("{\"accepted\":1,\"routes\":0,\"routes_truncated\":false}")
              : stub.metadataReplies.remove(0);
        } else {
          reply = new Reply(202, Map.of(), "{}");
        }
      }
      reply.headers().forEach((name, value) -> exchange.getResponseHeaders().add(name, value));
      byte[] out = reply.body().getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().add("Content-Type", "application/json");
      exchange.sendResponseHeaders(reply.status(), out.length == 0 ? -1 : out.length);
      if (out.length > 0) {
        exchange.getResponseBody().write(out);
      }
      exchange.close();
    });
    http.start();
    return stub;
  }

  /** A contract-checked heartbeat response body carrying {@code policy}. */
  public static String policy(RemotePolicy policy) {
    return IngestContract.available()
        ? IngestContract.heartbeatResponse(policy.toWire())
        : json(Map.of("policy", policy.toWire()));
  }

  private static String json(Object value) {
    try {
      return MAPPER.writeValueAsString(value);
    } catch (IOException ex) {
      throw new IllegalStateException(ex);
    }
  }

  /** Replaces the heartbeat script; the last reply repeats. Counting restarts. */
  public synchronized HeartbeatStub heartbeatReplies(Reply... replies) {
    heartbeatReplies.clear();
    heartbeatReplies.addAll(List.of(replies));
    heartbeatsAnswered = 0;
    return this;
  }

  public synchronized HeartbeatStub metadataReplies(Reply... replies) {
    metadataReplies.clear();
    metadataReplies.addAll(List.of(replies));
    return this;
  }

  public synchronized List<Received> heartbeats() {
    return received.stream().filter(r -> r.path().endsWith("/heartbeat")).toList();
  }

  public synchronized List<Received> metadata() {
    return received.stream().filter(r -> r.path().endsWith("/metadata")).toList();
  }

  public synchronized List<Received> requests() {
    return received.stream().filter(r -> r.path().endsWith("/requests")).toList();
  }

  public String baseUrl() {
    return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
  }

  /** Waits up to {@code timeout} for {@code condition}; returns whether it held. */
  public static boolean await(BooleanSupplier condition, Duration timeout) throws InterruptedException {
    long deadline = System.nanoTime() + timeout.toNanos();
    while (System.nanoTime() < deadline) {
      if (condition.getAsBoolean()) {
        return true;
      }
      Thread.sleep(10);
    }
    return condition.getAsBoolean();
  }

  @Override
  public void close() {
    server.stop(0);
  }
}
