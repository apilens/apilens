package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.internal.ExceptionInfo;
import ai.apilens.internal.Strings;
import jakarta.servlet.ServletException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class ExceptionInfoTest {
  private static final Pattern MARKER = Pattern.compile("\n…\\[(\\d+) chars truncated\\]…\n");

  @Test
  void servletWrappedExceptionIsReportedAsTheInnerClass() {
    IllegalStateException inner = new IllegalStateException("payment gateway down");
    ServletException wrapped = new ServletException("Request processing failed: " + inner, inner);

    ExceptionInfo info = ExceptionInfo.of(new ServletException("outer", wrapped));

    assertEquals("java.lang.IllegalStateException", info.type());
    assertEquals("payment gateway down", info.message());
    assertEquals("java.lang.IllegalStateException: payment gateway down", info.summary());
    assertTrue(info.payload().startsWith("java.lang.IllegalStateException: payment gateway down"),
        info.payload());
    assertEquals("java.lang.IllegalStateException", info.attributes().get("exception.type"));
    assertEquals("payment gateway down", info.attributes().get("exception.message"));
    assertEquals("1", info.attributes().get("exception.chain_depth"));
  }

  @Test
  void servletExceptionWithoutCauseIsKept() {
    ServletException bare = new ServletException("no handler");
    assertSame(bare, ExceptionInfo.unwrap(bare));
    assertEquals("jakarta.servlet.ServletException", ExceptionInfo.of(bare).type());
    assertNull(ExceptionInfo.of(null));
  }

  @Test
  void qualifiedTypeAndCausesAndSuppressedArePresent() {
    Exception root = new java.io.IOException("socket reset");
    RuntimeException middle = new IllegalStateException("db unavailable", root);
    RuntimeException top = new RuntimeException("charge failed", middle);
    top.addSuppressed(new IllegalArgumentException("cleanup failed"));

    ExceptionInfo info = ExceptionInfo.of(top);

    assertEquals("java.lang.RuntimeException", info.type());
    assertEquals(3, info.chainDepth());
    String payload = info.payload();
    assertTrue(payload.contains("Caused by: java.lang.IllegalStateException: db unavailable"), payload);
    assertTrue(payload.contains("Caused by: java.io.IOException: socket reset"), payload);
    assertTrue(payload.contains("Suppressed: java.lang.IllegalArgumentException: cleanup failed"), payload);
  }

  @Test
  void rootCauseSurvivesA200KbStack() {
    Throwable root = new IllegalStateException("ROOT CAUSE connection refused");
    Throwable current = root;
    // Deep, distinct wrappers so the printed trace is well over 200 KB.
    for (int i = 0; i < 40; i++) {
      current = deep(i, 200, new RuntimeException("layer " + i, current));
    }
    StringBuilder full = new StringBuilder();
    java.io.StringWriter out = new java.io.StringWriter();
    current.printStackTrace(new java.io.PrintWriter(out));
    full.append(out);
    assertTrue(full.length() > 200 * 1024, "stack is " + full.length() + " chars");

    String payload = ExceptionInfo.of(current).payload();

    assertTrue(payload.length() <= ExceptionInfo.MAX_PAYLOAD_CHARS, "capped at 64 KiB: " + payload.length());
    assertTrue(payload.startsWith("java.lang.RuntimeException: layer 39"), "head kept");
    assertTrue(payload.contains("Caused by: java.lang.IllegalStateException: ROOT CAUSE connection refused"),
        "root cause kept in the tail");
    Matcher marker = MARKER.matcher(payload);
    assertTrue(marker.find(), "marker present");
    int dropped = Integer.parseInt(marker.group(1));
    assertEquals(full.length(), payload.length() - marker.group().length() + dropped);
  }

  @Test
  void logRecordKeepsHeadAndTailOfALongPayload() {
    String big = "HEAD\n" + "x".repeat(200 * 1024) + "\nTAIL";
    LogRecord record = LogRecord.builder().payload(big).build();
    String payload = (String) record.toWire(ApiLensConfig.builder().apiKey("k").build()).get("payload");
    assertTrue(payload.length() <= LogRecord.MAX_PAYLOAD_CHARS);
    assertTrue(payload.startsWith("HEAD\n"));
    assertTrue(payload.endsWith("\nTAIL"));
    assertTrue(MARKER.matcher(payload).find());
  }

  @Test
  void truncateHeadTailEdgeCases() {
    assertEquals("", Strings.truncateHeadTail(null, 10));
    assertEquals("short", Strings.truncateHeadTail("short", 10));
    assertEquals("abcdefghij", Strings.truncateHeadTail("abcdefghij", 10));
    assertEquals("xxxxx", Strings.truncateHeadTail("x".repeat(50), 5), "cap too small for the marker");
    assertEquals("a".repeat(8) + "\n…[44 chars truncated]…\n" + "z".repeat(8),
        Strings.truncateHeadTail("a".repeat(30) + "z".repeat(30), 40), "same cut as ingest");
    String emoji = "😀".repeat(100);
    String cut = Strings.truncateHeadTail(emoji, 41);
    assertTrue(cut.length() <= 41);
    assertTrue(!Character.isHighSurrogate(cut.charAt(cut.indexOf('\n') - 1)), "no split pair at head");
    assertTrue(!Character.isLowSurrogate(cut.charAt(cut.lastIndexOf('\n') + 1)), "no split pair at tail");
  }

  private static RuntimeException deep(int layer, int frames, RuntimeException ex) {
    StackTraceElement[] trace = new StackTraceElement[frames];
    for (int i = 0; i < frames; i++) {
      trace[i] = new StackTraceElement("com.example.layer" + layer + ".Service" + i, "handle" + i, "Layer" + i + ".java", i + 1);
    }
    ex.setStackTrace(trace);
    return ex;
  }
}
