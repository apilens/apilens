package ai.apilens.internal;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The full exception for an {@code apilens.exception} log (D3): qualified type, message, every
 * frame and every chained cause and suppressed exception, as {@link Throwable#printStackTrace}
 * prints them.
 *
 * <p>Servlet containers and Spring MVC wrap the handler's exception in a {@code ServletException}
 * ("Request processing failed"). That wrapper is unwrapped, so the type and message are the
 * handler's own. The check is by class name, so this class loads without the Servlet API on the
 * classpath (WebFlux-only apps).
 */
public final class ExceptionInfo {
  /** Payload cap (D4): 64 KiB, head and tail kept. */
  public static final int MAX_PAYLOAD_CHARS = 64 * 1024;

  private static final int MAX_MESSAGE_CHARS = 4000;
  private static final Set<String> WRAPPERS = Set.of(
      "jakarta.servlet.ServletException",
      "javax.servlet.ServletException",
      "org.springframework.web.util.NestedServletException");

  private final Throwable throwable;
  private final String type;
  private final String message;
  private final int chainDepth;

  private ExceptionInfo(Throwable throwable) {
    this.throwable = throwable;
    this.type = throwable.getClass().getName();
    this.message = Strings.truncate(throwable.getMessage(), MAX_MESSAGE_CHARS);
    this.chainDepth = chainDepth(throwable);
  }

  /** Describes {@code throwable} after unwrapping servlet wrappers; null for a null throwable. */
  public static ExceptionInfo of(Throwable throwable) {
    return throwable == null ? null : new ExceptionInfo(unwrap(throwable));
  }

  /** The handler exception inside servlet wrappers (cycle-safe); the input when not wrapped. */
  public static Throwable unwrap(Throwable throwable) {
    Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    Throwable current = throwable;
    while (current != null && isWrapper(current) && current.getCause() != null && seen.add(current)) {
      current = current.getCause();
    }
    return current;
  }

  /** Fully qualified class name, e.g. {@code java.lang.IllegalStateException}. */
  public String type() {
    return type;
  }

  /** The exception's own message ("" when it has none). */
  public String message() {
    return message;
  }

  /** Exceptions in the {@code getCause()} chain, the reported one included (1 = no cause). */
  public int chainDepth() {
    return chainDepth;
  }

  /** "type: message", or the type alone when there is no message. */
  public String summary() {
    return Strings.isBlank(message) ? type : type + ": " + message;
  }

  /** The full stack trace (Caused by + Suppressed), capped head+tail at 64 KiB. */
  public String payload() {
    StringWriter out = new StringWriter();
    try (PrintWriter writer = new PrintWriter(out)) {
      throwable.printStackTrace(writer);
    }
    return Strings.truncateHeadTail(out.toString(), MAX_PAYLOAD_CHARS);
  }

  /** The {@code exception.*} log attributes (D3). */
  public Map<String, String> attributes() {
    Map<String, String> out = new LinkedHashMap<>();
    out.put("exception.type", type);
    out.put("exception.message", message);
    out.put("exception.chain_depth", Integer.toString(chainDepth));
    return out;
  }

  private static boolean isWrapper(Throwable throwable) {
    for (Class<?> cls = throwable.getClass(); cls != null; cls = cls.getSuperclass()) {
      if (WRAPPERS.contains(cls.getName())) {
        return true;
      }
    }
    return false;
  }

  private static int chainDepth(Throwable throwable) {
    Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    int depth = 0;
    for (Throwable current = throwable; current != null && seen.add(current); current = current.getCause()) {
      depth++;
    }
    return depth;
  }
}
