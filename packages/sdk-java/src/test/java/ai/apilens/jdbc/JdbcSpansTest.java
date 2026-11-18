package ai.apilens.jdbc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.ApiLensConfig;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class JdbcSpansTest {
  private static final String INCOMING = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  private static final String SECRET = "s3cr3t@example.com";

  private ApiLensClient client;
  private DataSource dataSource;

  @BeforeEach
  void setUp() throws SQLException {
    client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .environment("test")
        .baseUrl("http://127.0.0.1:9/v1")
        .sendHeartbeat(false)
        .sendMetadata(false)
        .build());
    client.stop();
    JdbcDataSource h2 = new JdbcDataSource();
    h2.setURL("jdbc:h2:mem:spans" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
    dataSource = ApiLensDataSource.wrap(h2, new ApiLensJdbcTracing(client, "", "checkout", true));
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.execute("CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255))");
    }
  }

  @AfterEach
  void tearDown() {
    client.shutdown();
  }

  private List<Map<String, Object>> release(TraceContext trace) {
    List<SpanRecord> spans = new ArrayList<>();
    trace.releaseChildSpans(true, spans::add);
    return spans.stream().map(span -> span.toWire(client.config())).collect(Collectors.toList());
  }

  @SuppressWarnings("unchecked")
  private static Map<String, String> attributes(Map<String, Object> span) {
    return (Map<String, String>) span.get("attributes");
  }

  @Test
  void queriesProduceDbSpansWithObfuscatedSql() throws SQLException {
    TraceContext trace = TraceContext.begin(INCOMING);
    try (TraceContext.Scope ignored = trace.makeCurrent();
        Connection connection = dataSource.getConnection()) {
      try (Statement statement = connection.createStatement()) {
        statement.executeUpdate("INSERT INTO users VALUES (1, '" + SECRET + "')");
      }
      try (PreparedStatement statement = connection.prepareStatement("SELECT email FROM users WHERE id = ?")) {
        statement.setInt(1, 1);
        try (ResultSet rows = statement.executeQuery()) {
          assertTrue(rows.next());
          assertEquals(SECRET, rows.getString(1));
        }
      }
      try (Statement statement = connection.createStatement()) {
        statement.addBatch("UPDATE users SET email = 'x@example.com' WHERE id = 1");
        statement.addBatch("DELETE FROM users WHERE id = 99");
        statement.executeBatch();
      }
    }
    List<Map<String, Object>> spans = release(trace);
    assertEquals(3, spans.size());
    for (Map<String, Object> span : spans) {
      assertEquals("db", span.get("kind"));
      assertEquals(trace.traceId(), span.get("trace_id"));
      assertEquals(trace.spanId(), span.get("parent_span_id"));
      assertEquals("checkout", span.get("service_name"));
      assertEquals("ok", span.get("status"));
      assertEquals("h2", attributes(span).get("db.system"));
      assertFalse(span.toString().contains(SECRET), span.toString());
      assertFalse(span.toString().contains("x@example.com"), span.toString());
    }
    assertEquals("INSERT INTO users VALUES (?, ?)", attributes(spans.get(0)).get("db.statement"));
    assertEquals("INSERT", attributes(spans.get(0)).get("db.operation"));
    assertEquals("INSERT INTO users VALUES (?, ?)", spans.get(0).get("name"));
    assertEquals("SELECT email FROM users WHERE id = ?", attributes(spans.get(1)).get("db.statement"));
    assertEquals("SELECT", attributes(spans.get(1)).get("db.operation"));
    assertEquals("UPDATE users SET email = ? WHERE id = ?; DELETE FROM users WHERE id = ?",
        attributes(spans.get(2)).get("db.statement"));
  }

  @Test
  void failedStatementIsAnErrorSpan() throws SQLException {
    TraceContext trace = TraceContext.begin("");
    try (TraceContext.Scope ignored = trace.makeCurrent();
        Connection connection = dataSource.getConnection();
        Statement statement = connection.createStatement()) {
      assertThrows(SQLException.class, () -> statement.executeQuery("SELECT * FROM missing WHERE a = 'x'"));
    }
    List<Map<String, Object>> spans = release(trace);
    assertEquals(1, spans.size());
    assertEquals("error", spans.get(0).get("status"));
    assertEquals("SELECT * FROM missing WHERE a = ?", attributes(spans.get(0)).get("db.statement"));
  }

  @Test
  void statementsOutsideARequestAreNotTraced() throws SQLException {
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      statement.executeQuery("SELECT 1").close();
    }
    TraceContext unrelated = TraceContext.begin("");
    assertTrue(release(unrelated).isEmpty());
  }

  @Test
  void tracingOffPassesStatementsThrough() throws SQLException {
    DataSource off = ApiLensDataSource.wrap(dataSource.unwrap(JdbcDataSource.class),
        new ApiLensJdbcTracing(client, "", "", false));
    TraceContext trace = TraceContext.begin("");
    try (TraceContext.Scope ignored = trace.makeCurrent();
        Connection connection = off.getConnection();
        Statement statement = connection.createStatement()) {
      statement.executeQuery("SELECT 1").close();
    }
    assertTrue(release(trace).isEmpty());
  }

  @Test
  void wrappersUnwrapAndAreNotWrappedTwice() throws SQLException {
    assertSame(dataSource, ApiLensDataSource.wrap(dataSource, ApiLensJdbcTracing.of(client)));
    assertTrue(dataSource.isWrapperFor(JdbcDataSource.class));
    try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
      assertSame(connection, statement.getConnection());
      assertSame(connection, ApiLensDataSource.wrap(connection, ApiLensJdbcTracing.of(client)));
      assertTrue(connection.unwrap(Connection.class) != null);
    }
  }

  @Test
  void capKeepsTwoThousandSpansAndCountsTheRest() throws SQLException {
    TraceContext trace = TraceContext.begin("");
    try (TraceContext.Scope ignored = trace.makeCurrent();
        Connection connection = dataSource.getConnection();
        PreparedStatement statement = connection.prepareStatement("SELECT 1")) {
      for (int i = 0; i < TraceContext.MAX_CHILD_SPANS + 5; i++) {
        statement.executeQuery().close();
      }
    }
    List<SpanRecord> spans = new ArrayList<>();
    trace.releaseChildSpans(true, spans::add, client::countSpanCapDrops);
    assertEquals(TraceContext.MAX_CHILD_SPANS, spans.size());
    assertEquals(5L, client.dropCounts().get(ApiLensClient.DROP_SPAN_CAP));
    assertEquals(5L, client.droppedCount());

    // A span finishing after the verdict is counted too.
    new ApiLensJdbcTracing(client, "", "", true).start(trace, "h2", "SELECT 2").end(null);
    assertEquals(6L, client.dropCounts().get(ApiLensClient.DROP_SPAN_CAP));
    assertEquals(TraceContext.MAX_CHILD_SPANS, spans.size());
  }

  @Test
  void spansOverTheCapOfADroppedRequestAreNotCounted() {
    TraceContext trace = TraceContext.begin("");
    ApiLensJdbcTracing tracing = ApiLensJdbcTracing.of(client);
    for (int i = 0; i < TraceContext.MAX_CHILD_SPANS + 3; i++) {
      tracing.start(trace, "h2", "SELECT 1").end(null);
    }
    AtomicLong counted = new AtomicLong();
    trace.releaseChildSpans(false, span -> { }, counted::addAndGet);
    assertEquals(0L, counted.get());
  }

  @Test
  void systemFromJdbcUrl() {
    assertEquals("postgresql", ApiLensJdbcTracing.systemFromUrl("jdbc:postgresql://db:5432/app"));
    assertEquals("mysql", ApiLensJdbcTracing.systemFromUrl("jdbc:mysql://db/app"));
    assertEquals("postgresql", ApiLensJdbcTracing.systemFromUrl("jdbc:tc:postgresql:16:///app"));
    assertEquals("mssql", ApiLensJdbcTracing.systemFromUrl("jdbc:sqlserver://db;databaseName=app"));
    assertEquals("h2", ApiLensJdbcTracing.systemFromUrl("jdbc:h2:mem:x"));
    assertEquals("other", ApiLensJdbcTracing.systemFromUrl(null));
  }
}
