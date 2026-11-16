package ai.apilens.logging;

import ai.apilens.ApiLensClient;
import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxy;
import ch.qos.logback.core.AppenderBase;
import java.time.Instant;
import org.slf4j.ILoggerFactory;
import org.slf4j.LoggerFactory;

/**
 * Logback appender that ships every event logged at ERROR with a throwable as an {@code
 * apilens.exception} log, tied to the current request's trace. Events without a throwable and
 * below ERROR are ignored.
 *
 * <p>Spring Boot attaches it to the root logger automatically ({@code apilens.capture-logs}); in
 * other apps call {@link #attach(ApiLensClient)}.
 */
public class ApiLensLogbackAppender extends AppenderBase<ILoggingEvent> {
  public static final String NAME = "APILENS";

  private final ApiLensClient client;
  private Logger attachedTo;

  public ApiLensLogbackAppender(ApiLensClient client) {
    this.client = client;
    setName(NAME);
  }

  /**
   * Starts an appender on the root logger of the active Logback context. When SLF4J is not bound
   * to Logback the appender is returned unattached and {@link #detach()} does nothing.
   */
  public static ApiLensLogbackAppender attach(ApiLensClient client) {
    ApiLensLogbackAppender appender = new ApiLensLogbackAppender(client);
    ILoggerFactory factory = LoggerFactory.getILoggerFactory();
    if (factory instanceof LoggerContext context) {
      appender.attachTo(context.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME));
    }
    return appender;
  }

  /** Starts this appender and adds it to {@code logger}. */
  public void attachTo(Logger logger) {
    setContext(logger.getLoggerContext());
    start();
    logger.addAppender(this);
    attachedTo = logger;
  }

  /** Removes this appender from the logger it was attached to and stops it. */
  public void detach() {
    if (attachedTo != null) {
      attachedTo.detachAppender(this);
      attachedTo = null;
    }
    stop();
  }

  @Override
  protected void append(ILoggingEvent event) {
    if (event == null || !event.getLevel().isGreaterOrEqual(Level.ERROR)) {
      return;
    }
    IThrowableProxy proxy = event.getThrowableProxy();
    if (!(proxy instanceof ThrowableProxy throwableProxy)) {
      return;
    }
    LoggedExceptions.capture(
        client,
        Instant.ofEpochMilli(event.getTimeStamp()),
        event.getLoggerName(),
        event.getFormattedMessage(),
        event.getThreadName(),
        throwableProxy.getThrowable());
  }
}
