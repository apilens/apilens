package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RedactorTest {
  @Test
  void redactsQueryParametersByName() {
    Redactor redactor = new Redactor(List.of("token"), List.of(), List.of());

    assertEquals("token=[redacted]&keep=1", redactor.redactQuery("token=secret&keep=1"));
  }

  @Test
  void redactsSensitiveHeadersAndConfiguredHeaders() {
    Redactor redactor = new Redactor(List.of(), List.of("x-private-.*"), List.of());

    String json = redactor.serializeHeaders(Map.of(
        "Authorization", "Bearer secret",
        "X-Private-Value", "secret",
        "Accept", "application/json"));

    assertTrue(json.contains("\"authorization\":\"[redacted]\""));
    assertTrue(json.contains("\"x-private-value\":\"[redacted]\""));
    assertTrue(json.contains("\"accept\":\"application/json\""));
  }

  @Test
  void redactsJsonBodyFieldsRecursively() {
    Redactor redactor = new Redactor(List.of(), List.of(), List.of("password"));

    String json = redactor.redactBody("{\"user\":{\"password\":\"secret\",\"name\":\"Alice\"}}");

    assertTrue(json.contains("\"password\":\"[redacted]\""));
    assertFalse(json.contains("secret"));
  }

  @Test
  void decodesTruncatedUtf8WithoutReplacementCharacter() {
    byte[] bytes = "hello \u20ac".getBytes(StandardCharsets.UTF_8);

    String decoded = Redactor.decodeUtf8Safe(bytes, bytes.length - 1);

    assertEquals("hello ", decoded);
  }
}
