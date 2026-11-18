package ai.apilens.jdbc;

import ai.apilens.ApiLensClient;
import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import ai.apilens.internal.Strings;
import java.time.Instant;
import java.util.Locale;

/**
 * Turns JDBC statements run while a request is being captured into child {@code db} spans of
 * that request's server span. Used by {@link ApiLensDataSource}, which Spring Boot applies to
 * every {@code DataSource} bean.
 *
 * <p>A statement run outside a captured request (no current trace) is not traced. Spans carry
 * {@code db.system} (from the JDBC URL: {@code postgresql}, {@code mysql}, {@code h2}, …), {@code
 * db.operation} (the first keyword) and {@code db.statement}: the SQL with every literal replaced
 * by {@code ?} ({@link SqlObfuscator}), cut to 2 KiB. Status is {@code error} when the statement
 * threw. Per request at most {@link TraceContext#MAX_CHILD_SPANS} child spans are kept.
 */
public final class ApiLensJdbcTracing {
  static final int MAX_NAME_CHARS = 256;

  private final ApiLensClient client;
  private final String environment;
  private final String serviceName;
  private final boolean enabled;

  public ApiLensJdbcTracing(ApiLensClient client, String environment, String serviceName, boolean enabled) {
    this.client = client;
    this.environment = Strings.clean(environment);
    this.serviceName = Strings.clean(serviceName);
    this.enabled = enabled && client != null;
  }

  /** Tracing with the client's environment and app id as the service name. */
  public static ApiLensJdbcTracing of(ApiLensClient client) {
    return new ApiLensJdbcTracing(client, "", "", true);
  }

  public boolean enabled() {
    return enabled;
  }

  /**
   * Starts a {@code db} span for {@code sql} under {@code trace}, or returns {@code null} when the
   * statement is not traced (no current request or tracing off).
   */
  public DbSpan start(TraceContext trace, String system, String sql) {
    if (!enabled || trace == null || Strings.isBlank(trace.traceId()) || Strings.isBlank(trace.spanId())) {
      return null;
    }
    String dbSystem = Strings.firstNonBlank(system, "other");
    String statement = SqlObfuscator.obfuscate(sql, dbSystem);
    return new DbSpan(trace, dbSystem, SqlObfuscator.operation(statement), statement);
  }

  /** Same as {@link #start(TraceContext, String, String)} under the current thread's trace. */
  public DbSpan start(String system, String sql) {
    return start(TraceContext.current(), system, sql);
  }

  /** {@code db.system} for a JDBC URL ({@code jdbc:postgresql:…} is {@code postgresql}). */
  public static String systemFromUrl(String jdbcUrl) {
    String url = Strings.clean(jdbcUrl).toLowerCase(Locale.ROOT);
    if (!url.startsWith("jdbc:")) {
      return "other";
    }
    String rest = url.substring(5);
    if (rest.startsWith("p6spy:") || rest.startsWith("tc:")) {
      rest = rest.substring(rest.indexOf(':') + 1);
    }
    int colon = rest.indexOf(':');
    String vendor = colon < 0 ? rest : rest.substring(0, colon);
    switch (vendor) {
      case "postgresql":
      case "pgsql":
        return "postgresql";
      case "mysql":
        return "mysql";
      case "mariadb":
        return "mariadb";
      case "sqlserver":
      case "jtds":
        return "mssql";
      case "oracle":
        return "oracle";
      case "h2":
        return "h2";
      case "hsqldb":
        return "hsqldb";
      case "sqlite":
        return "sqlite";
      case "derby":
        return "derby";
      case "db2":
        return "db2";
      case "clickhouse":
      case "ch":
        return "clickhouse";
      default:
        return vendor.isEmpty() ? "other" : vendor;
    }
  }

  /** One statement in flight. {@link #end} records it; only the first call counts. */
  public final class DbSpan {
    private final TraceContext trace;
    private final String system;
    private final String operation;
    private final String statement;
    private final String spanId = TraceContext.newSpanId();
    private final Instant startedAt = Instant.now();
    private final long startedNanos = System.nanoTime();
    private boolean ended;

    private DbSpan(TraceContext trace, String system, String operation, String statement) {
      this.trace = trace;
      this.system = system;
      this.operation = operation;
      this.statement = statement;
    }

    public String statement() {
      return statement;
    }

    /** Records the span; {@code error} when the statement threw. */
    public void end(Throwable error) {
      synchronized (this) {
        if (ended) {
          return;
        }
        ended = true;
      }
      double elapsedMs = Math.max((System.nanoTime() - startedNanos) / 1_000_000.0, 0.0);
      String name = Strings.firstNonBlank(statement, (system + " " + operation).trim());
      if (name.length() > MAX_NAME_CHARS) {
        name = name.substring(0, MAX_NAME_CHARS);
      }
      SpanRecord.Builder span = SpanRecord.builder()
          .timestamp(startedAt)
          .environment(Strings.firstNonBlank(environment, client.config().environment()))
          .traceId(trace.traceId())
          .spanId(spanId)
          .parentSpanId(trace.spanId())
          .name(name)
          .kind("db")
          .serviceName(Strings.firstNonBlank(serviceName, client.config().appId()))
          .durationMs(elapsedMs)
          .status(error != null ? "error" : "ok")
          .projectSlug(client.config().projectSlug())
          .appId(client.config().appId())
          .attribute("db.system", system);
      if (!operation.isEmpty()) {
        span.attribute("db.operation", operation);
      }
      if (!statement.isEmpty()) {
        span.attribute("db.statement", statement);
      }
      trace.recordChildSpan(span.build());
    }
  }
}
