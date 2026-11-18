package ai.apilens.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

class OutboundHttpSpansTest {
  private static final String INCOMING =
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  private HttpServer downstream;
  private final List<String> receivedTraceparents = new CopyOnWriteArrayList<>();
  private ApiLensClient client;
  private ApiLensHttpTracing tracing;

  @BeforeEach
  void setUp() throws IOException {
    downstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    downstream.createContext("/", exchange -> {
      String header = exchange.getRequestHeaders().getFirst("traceparent");
      receivedTraceparents.add(header == null ? "" : header);
      exchange.getRequestBody().readAllBytes();
      int status = exchange.getRequestURI().getPath().startsWith("/boom") ? 503 : 200;
      exchange.sendResponseHeaders(status, -1);
      exchange.close();
    });
    downstream.start();
    client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .environment("test")
        .baseUrl("http://127.0.0.1:9/v1")
        .sendHeartbeat(false)
        .sendMetadata(false)
        .build());
    client.stop();
    tracing = new ApiLensHttpTracing(client, "", "checkout", true);
  }

  @AfterEach
  void tearDown() {
    downstream.stop(0);
    client.shutdown();
  }

  private String url(String path) {
    return "http://127.0.0.1:" + downstream.getAddress().getPort() + path;
  }

  private static List<SpanRecord> release(TraceContext trace) {
    List<SpanRecord> spans = new ArrayList<>();
    trace.releaseChildSpans(true, spans::add);
    return spans;
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> wire(SpanRecord span) {
    return span.toWire(client.config());
  }

  /** The child span is under the server span and its id is the one sent downstream. */
  private void assertChild(TraceContext trace, SpanRecord span, String method, String path, int status,
      String spanStatus) {
    Map<String, Object> wire = wire(span);
    assertEquals(trace.traceId(), wire.get("trace_id"));
    assertEquals(trace.spanId(), wire.get("parent_span_id"));
    assertEquals("http", wire.get("kind"));
    assertEquals("checkout", wire.get("service_name"));
    assertEquals(method + " " + url(path), wire.get("name"));
    assertEquals(status, wire.get("status_code"));
    assertEquals(spanStatus, wire.get("status"));
    Map<String, String> attributes = (Map<String, String>) wire.get("attributes");
    assertEquals(Map.of("http.url", url(path), "http.method", method), attributes);
  }

  private void assertPropagated(TraceContext trace, SpanRecord span) {
    assertEquals(List.of("00-" + trace.traceId() + "-" + wire(span).get("span_id") + "-01"), receivedTraceparents);
  }

  @Test
  void restTemplateRecordsChildSpanAndSendsTraceparent() {
    RestTemplate restTemplate = new RestTemplate();
    restTemplate.getInterceptors().add(new ApiLensClientHttpRequestInterceptor(tracing));
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      restTemplate.getForEntity(url("/orders?token=secret"), String.class);
    }

    List<SpanRecord> spans = release(trace);
    assertEquals(1, spans.size());
    assertChild(trace, spans.get(0), "GET", "/orders", 200, "ok");
    assertPropagated(trace, spans.get(0));
    assertFalse(String.valueOf(wire(spans.get(0))).contains("secret"));
  }

  @Test
  void restClientMarksServerErrorsAsError() {
    RestClient restClient = RestClient.builder()
        .requestInterceptor(new ApiLensClientHttpRequestInterceptor(tracing))
        .build();
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      assertThrows(RuntimeException.class,
          () -> restClient.post().uri(url("/boom")).body("{}").retrieve().toBodilessEntity());
    }

    List<SpanRecord> spans = release(trace);
    assertEquals(1, spans.size());
    assertChild(trace, spans.get(0), "POST", "/boom", 503, "error");
    assertPropagated(trace, spans.get(0));
  }

  @Test
  void webClientReadsTheTraceFromTheReactorContext() {
    WebClient webClient = WebClient.builder().filter(new ApiLensExchangeFilterFunction(tracing)).build();
    TraceContext trace = TraceContext.begin(INCOMING);
    // No thread-local scope: a WebFlux handler only has the trace in the Reactor context.
    webClient.get().uri(url("/inventory")).retrieve().toBodilessEntity()
        .contextWrite(context -> context.put(TraceContext.class, trace))
        .block(Duration.ofSeconds(10));

    List<SpanRecord> spans = release(trace);
    assertEquals(1, spans.size());
    assertChild(trace, spans.get(0), "GET", "/inventory", 200, "ok");
    assertPropagated(trace, spans.get(0));
  }

  @Test
  void webClientUsesTheCallingThreadsTraceInAServletApp() {
    WebClient webClient = WebClient.builder().filter(new ApiLensExchangeFilterFunction(tracing)).build();
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      webClient.get().uri(url("/boom")).exchangeToMono(response -> response.releaseBody())
          .block(Duration.ofSeconds(10));
    }

    List<SpanRecord> spans = release(trace);
    assertEquals(1, spans.size());
    assertChild(trace, spans.get(0), "GET", "/boom", 503, "error");
    assertPropagated(trace, spans.get(0));
  }

  @Test
  void javaHttpClientSyncAndAsync() throws Exception {
    HttpClient httpClient = ApiLensHttpClient.wrap(HttpClient.newHttpClient(), tracing);
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      HttpResponse<Void> sync = httpClient.send(
          HttpRequest.newBuilder(URI.create(url("/a?x=1"))).build(), HttpResponse.BodyHandlers.discarding());
      assertEquals(200, sync.statusCode());
      httpClient.sendAsync(
          HttpRequest.newBuilder(URI.create(url("/boom"))).DELETE().build(), HttpResponse.BodyHandlers.discarding())
          .get();
    }

    List<SpanRecord> spans = release(trace);
    assertEquals(2, spans.size());
    assertChild(trace, spans.get(0), "GET", "/a", 200, "ok");
    assertChild(trace, spans.get(1), "DELETE", "/boom", 503, "error");
    assertEquals(List.of(
        "00-" + trace.traceId() + "-" + wire(spans.get(0)).get("span_id") + "-01",
        "00-" + trace.traceId() + "-" + wire(spans.get(1)).get("span_id") + "-01"), receivedTraceparents);
    assertTrue(ApiLensHttpClient.wrap(httpClient, tracing) == httpClient);
  }

  @Test
  void javaHttpClientConnectionFailureIsAnErrorSpan() throws Exception {
    HttpClient httpClient = ApiLensHttpClient.wrap(HttpClient.newHttpClient(), tracing);
    int port;
    try (java.net.ServerSocket closed = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
      port = closed.getLocalPort();
    }
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent()) {
      assertThrows(IOException.class, () -> httpClient.send(
          HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/down"))
              .timeout(Duration.ofSeconds(5)).build(),
          HttpResponse.BodyHandlers.discarding()));
    }

    List<SpanRecord> spans = release(trace);
    assertEquals(1, spans.size());
    assertEquals("error", wire(spans.get(0)).get("status"));
    assertEquals(0, wire(spans.get(0)).get("status_code"));
  }

  @Test
  void callsOutsideACapturedRequestAreUntouched() throws Exception {
    RestTemplate restTemplate = new RestTemplate();
    restTemplate.getInterceptors().add(new ApiLensClientHttpRequestInterceptor(tracing));
    restTemplate.getForEntity(url("/plain"), String.class);
    ApiLensHttpClient.wrap(HttpClient.newHttpClient(), tracing).send(
        HttpRequest.newBuilder(URI.create(url("/plain"))).build(), HttpResponse.BodyHandlers.discarding());

    assertEquals(List.of("", ""), receivedTraceparents);
  }

  @Test
  void disabledTracingAndOwnIngestAreNotTraced() {
    TraceContext trace = TraceContext.begin(INCOMING);
    ApiLensHttpTracing off = new ApiLensHttpTracing(client, "", "", false);
    assertNull(off.start(trace, "GET", URI.create(url("/x"))));
    assertNull(tracing.start(trace, "POST", URI.create("http://127.0.0.1:9/v1/traces")));
  }

  @Test
  void stripsUserinfoQueryAndFragment() {
    assertEquals("https://api.example.com:8443/v1/pay",
        ApiLensHttpTracing.stripUrl(URI.create("https://user:pw@api.example.com:8443/v1/pay?card=4111#frag")));
  }

  @Test
  void childSpansFollowTheRequestsSamplingVerdict() {
    TraceContext dropped = TraceContext.begin(INCOMING);
    tracing.start(dropped, "GET", URI.create(url("/x"))).end(200, null);
    List<SpanRecord> sink = new ArrayList<>();
    dropped.releaseChildSpans(false, sink::add);
    tracing.start(dropped, "GET", URI.create(url("/late"))).end(200, null);
    assertTrue(sink.isEmpty());

    TraceContext kept = TraceContext.begin(INCOMING);
    kept.releaseChildSpans(true, sink::add);
    // A span that finishes after the request (a background call) follows the verdict.
    tracing.start(kept, "GET", URI.create(url("/late"))).end(200, null);
    assertEquals(1, sink.size());
  }
}
