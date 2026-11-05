package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import org.junit.jupiter.api.Test;

class BodyMaskingTest {
  private static final RequestInfo INFO = new RequestInfo(
      "POST", "/login", "/login?x=1", Map.of("content-type", "application/json"));

  private static byte[] utf8(String value) {
    return value.getBytes(StandardCharsets.UTF_8);
  }

  @Test
  void callbackRunsOnRawBytesBeforeRegexMasking() {
    Redactor redactor = new Redactor(List.of(), List.of(), List.of("password"));
    List<String> order = new ArrayList<>();
    AtomicReference<String> seen = new AtomicReference<>();
    BiFunction<RequestInfo, byte[], byte[]> masker = (info, body) -> {
      order.add("callback");
      seen.set(new String(body, StandardCharsets.UTF_8));
      // The callback adds a field the regex patterns must still catch.
      return utf8("{\"password\":\"added\",\"card\":\"[cb]\"}");
    };

    String out = redactor.maskBody(
        utf8("{\"password\":\"secret\",\"card\":\"4111\"}"), "application/json", masker, INFO, 1024);

    assertEquals(List.of("callback"), order);
    assertEquals("{\"password\":\"secret\",\"card\":\"4111\"}", seen.get(), "callback sees the raw body");
    assertEquals("{\"password\":\"[redacted]\",\"card\":\"[cb]\"}", out);
  }

  @Test
  void callbackReceivesInfoAndTruncatedBytes() {
    Redactor redactor = new Redactor();
    AtomicReference<RequestInfo> seenInfo = new AtomicReference<>();
    AtomicReference<byte[]> seenBody = new AtomicReference<>();
    BiFunction<RequestInfo, byte[], byte[]> masker = (info, body) -> {
      seenInfo.set(info);
      seenBody.set(body);
      return body;
    };

    String out = redactor.maskBody(utf8("abcdefgh"), "text/plain; charset=utf-8", masker, INFO, 4);

    assertEquals(INFO, seenInfo.get());
    assertEquals("application/json", seenInfo.get().contentType());
    assertArrayEquals(utf8("abcd"), seenBody.get());
    assertEquals("abcd", out);
  }

  @Test
  void nullResultFailsClosed() {
    Redactor redactor = new Redactor();

    String out = redactor.maskBody(utf8("{\"a\":1}"), "application/json", (info, body) -> null, INFO, 1024);

    assertEquals(Redactor.MASKED, out);
  }

  @Test
  void throwingCallbackFailsClosed() {
    Redactor redactor = new Redactor();
    BiFunction<RequestInfo, byte[], byte[]> masker = (info, body) -> {
      throw new IllegalStateException("boom");
    };

    String out = redactor.maskBody(utf8("{\"token\":\"raw-secret\"}"), "application/json", masker, INFO, 1024);

    assertEquals(Redactor.MASKED, out);
    assertFalse(out.contains("raw-secret"));
  }

  @Test
  void callbackCannotMutateCapturedBuffer() {
    Redactor redactor = new Redactor();
    byte[] body = utf8("hello");

    redactor.maskBody(body, "text/plain", (info, bytes) -> {
      bytes[0] = 'X';
      return bytes;
    }, INFO, 1024);

    assertArrayEquals(utf8("hello"), body);
  }

  @Test
  void emptyBodySkipsCallback() {
    Redactor redactor = new Redactor();
    AtomicInteger calls = new AtomicInteger();

    String out = redactor.maskBody(new byte[0], "application/json", (info, body) -> {
      calls.incrementAndGet();
      return body;
    }, INFO, 1024);

    assertEquals("", out);
    assertEquals(0, calls.get());
  }

  @Test
  void nonCapturableContentTypeStoresPlaceholderWithoutCallingBack() {
    Redactor redactor = new Redactor();
    AtomicInteger calls = new AtomicInteger();
    BiFunction<RequestInfo, byte[], byte[]> masker = (info, body) -> {
      calls.incrementAndGet();
      return body;
    };

    assertEquals("[image/png, 3 bytes omitted]",
        redactor.maskBody(new byte[] {1, 2, 3}, "image/png", masker, INFO, 1024));
    assertEquals("[multipart/form-data, 2 bytes omitted]",
        redactor.maskBody(utf8("--"), "multipart/form-data; boundary=x", masker, INFO, 1024));
    assertEquals("[application/octet-stream, 1 bytes omitted]",
        redactor.maskBody(new byte[] {7}, "", masker, INFO, 1024));
    assertEquals(0, calls.get());
  }

  @Test
  void formEncodedBodyIsMaskedViaQueryRedactor() {
    Redactor redactor = new Redactor(List.of("token"), List.of(), List.of("password"));

    String out = redactor.maskBody(
        utf8("user=alice&password=hunter2&token=abc&keep=1"),
        "application/x-www-form-urlencoded; charset=UTF-8",
        null,
        INFO,
        1024);

    assertEquals("user=alice&password=[redacted]&token=[redacted]&keep=1", out);
  }

  @Test
  void formEncodedCallbackOutputIsStillMasked() {
    Redactor redactor = new Redactor(List.of(), List.of(), List.of("pass"));

    String out = redactor.maskBody(
        utf8("a=1"),
        "application/x-www-form-urlencoded",
        (info, body) -> utf8("a=1&passcode=9"),
        INFO,
        1024);

    assertEquals("a=1&passcode=[redacted]", out);
  }

  @Test
  void classifiesContentTypes() {
    assertTrue(Redactor.isCapturableContentType("application/json"));
    assertTrue(Redactor.isCapturableContentType("Application/JSON; charset=utf-8"));
    assertTrue(Redactor.isCapturableContentType("application/problem+json"));
    assertTrue(Redactor.isCapturableContentType("text/plain"));
    assertTrue(Redactor.isCapturableContentType("text/html;charset=UTF-8"));
    assertTrue(Redactor.isCapturableContentType("application/x-www-form-urlencoded"));
    assertFalse(Redactor.isCapturableContentType("multipart/form-data; boundary=abc"));
    assertFalse(Redactor.isCapturableContentType("application/octet-stream"));
    assertFalse(Redactor.isCapturableContentType("application/pdf"));
    assertFalse(Redactor.isCapturableContentType(""));
    assertFalse(Redactor.isCapturableContentType(null));
  }
}
