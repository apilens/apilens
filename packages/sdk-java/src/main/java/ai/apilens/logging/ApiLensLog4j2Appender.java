package ai.apilens.logging;

import ai.apilens.ApiLensClient;
import java.beans.PropertyChangeListener;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.LoggerContext;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Configuration;
import org.apache.logging.log4j.core.config.Property;

/**
 * Log4j2 appender that ships every event logged at ERROR with a throwable as an {@code
 * apilens.exception} log, tied to the current request's trace. Events without a throwable and
 * below ERROR are ignored.
 *
 * <p>Spring Boot attaches it to the root logger automatically when Log4j2 is the logging system
 * ({@code apilens.capture-logs}); in other apps call {@link #attach(ApiLensClient)}. It is
 * re-attached when Log4j2 reloads its configuration.
 */
public class ApiLensLog4j2Appender extends AbstractAppender {
  public static final String NAME = "APILENS";

  private final ApiLensClient client;
  private LoggerContext attachedTo;
  private PropertyChangeListener reattach;
  private volatile boolean detaching;

  public ApiLensLog4j2Appender(ApiLensClient client) {
    super(NAME, null, null, true, Property.EMPTY_ARRAY);
    this.client = client;
  }

  /**
   * Starts an appender on the root logger of the active Log4j2 context. When the Log4j2 API is not
   * backed by log4j-core the appender is returned unattached and {@link #detach()} does nothing.
   */
  public static ApiLensLog4j2Appender attach(ApiLensClient client) {
    ApiLensLog4j2Appender appender = new ApiLensLog4j2Appender(client);
    if (LogManager.getContext(false) instanceof LoggerContext context) {
      appender.attachTo(context);
    }
    return appender;
  }

  /** Starts this appender and adds it to the root logger of {@code context}. */
  public void attachTo(LoggerContext context) {
    start();
    addTo(context.getConfiguration());
    context.updateLoggers();
    reattach = event -> {
      if (LoggerContext.PROPERTY_CONFIG.equals(event.getPropertyName())
          && event.getNewValue() instanceof Configuration configuration) {
        // Fired after the loggers already point at the new configuration's LoggerConfigs, which
        // pick the appender up in place; calling updateLoggers here would fire this again.
        addTo(configuration);
      }
    };
    context.addPropertyChangeListener(reattach);
    attachedTo = context;
  }

  /** Removes this appender from the context it was attached to and stops it. */
  public void detach() {
    if (attachedTo != null) {
      attachedTo.removePropertyChangeListener(reattach);
      attachedTo.getConfiguration().getRootLogger().removeAppender(NAME);
      attachedTo.updateLoggers();
      attachedTo = null;
    }
    detaching = true;
    stop();
  }

  /**
   * Ignored until {@link #detach()}: Log4j2 stops the previous configuration's appenders when it
   * reloads, and this instance moves to the new configuration rather than being replaced.
   */
  @Override
  public boolean stop(long timeout, TimeUnit timeUnit) {
    if (!detaching) {
      return true;
    }
    return super.stop(timeout, timeUnit);
  }

  private void addTo(Configuration configuration) {
    if (configuration.getRootLogger().getAppenders().containsKey(NAME)) {
      return;
    }
    configuration.addAppender(this);
    configuration.getRootLogger().addAppender(this, Level.ERROR, null);
  }

  @Override
  public void append(LogEvent event) {
    if (event == null || event.getThrown() == null || !event.getLevel().isMoreSpecificThan(Level.ERROR)) {
      return;
    }
    LoggedExceptions.capture(
        client,
        Instant.ofEpochMilli(event.getTimeMillis()),
        event.getLoggerName(),
        event.getMessage() == null ? "" : event.getMessage().getFormattedMessage(),
        event.getThreadName(),
        event.getThrown());
  }
}
