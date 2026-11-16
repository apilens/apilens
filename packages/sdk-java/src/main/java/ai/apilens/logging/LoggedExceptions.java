package ai.apilens.logging;

import ai.apilens.ApiLensClient;
import ai.apilens.LogRecord;
import ai.apilens.TraceContext;
import ai.apilens.internal.ExceptionInfo;
import ai.apilens.internal.Strings;
import java.time.Instant;
import java.util.Map;

/**
 * Turns an exception an application logged at ERROR into an {@code apilens.exception} log (D3):
 * the full payload from {@link ExceptionInfo}, tied to the current request's trace when the event
 * is logged inside a request the API Lens filter is handling. Shared by the Logback and Log4j2
 * appenders.
 */
public final class LoggedExceptions {
  /** Logger name of the records these appenders send, the same as the filter's exception log. */
  public static final String LOGGER_NAME = "apilens.exception";

  private static final int MAX_LOG_MESSAGE_CHARS = 4000;
  private static final ThreadLocal<Boolean> SENDING = new ThreadLocal<>();

  private LoggedExceptions() {}

  /**
   * True when an event from {@code loggerName} must not be shipped: the SDK's own loggers (a
   * failed delivery logged at ERROR would otherwise feed itself) and events logged while one is
   * being shipped on this thread.
   */
  static boolean ignored(String loggerName) {
    return SENDING.get() != null || (loggerName != null && loggerName.startsWith("ai.apilens."));
  }

  /**
   * Builds and enqueues the exception log for {@code throwable}; a null throwable sends nothing.
   * Never throws: a logging call must not fail because of API Lens.
   */
  static void capture(
      ApiLensClient client,
      Instant timestamp,
      String loggerName,
      String loggedMessage,
      String threadName,
      Throwable throwable) {
    if (client == null || throwable == null || ignored(loggerName)) {
      return;
    }
    SENDING.set(Boolean.TRUE);
    try {
      client.captureLog(record(client, timestamp, loggerName, loggedMessage, threadName, throwable));
    } catch (RuntimeException ignored) {
      // Best effort: the application's own log line has already been written.
    } finally {
      SENDING.remove();
    }
  }

  /** The {@code apilens.exception} record for a logged throwable. */
  public static LogRecord record(
      ApiLensClient client,
      Instant timestamp,
      String loggerName,
      String loggedMessage,
      String threadName,
      Throwable throwable) {
    ExceptionInfo exception = ExceptionInfo.of(throwable);
    TraceContext trace = TraceContext.current();
    LogRecord.Builder builder = LogRecord.builder()
        .timestamp(timestamp == null ? Instant.now() : timestamp)
        .level("ERROR")
        .message(exception.summary())
        .loggerName(LOGGER_NAME)
        .traceId(trace.traceId())
        .spanId(trace.spanId())
        .projectSlug(client.config().projectSlug())
        .appId(client.config().appId())
        .payload(exception.payload());
    Map<String, String> attributes = exception.attributes();
    attributes.put("log.logger", Strings.clean(loggerName));
    attributes.put("log.message", Strings.truncate(loggedMessage, MAX_LOG_MESSAGE_CHARS));
    if (!Strings.isBlank(threadName)) {
      attributes.put("thread.name", threadName);
    }
    return builder.attributes(attributes).build();
  }
}
