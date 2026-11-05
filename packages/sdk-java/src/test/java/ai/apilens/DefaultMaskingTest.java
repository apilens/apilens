package ai.apilens;

import static ai.apilens.Redactor.REDACTED;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.PatternSyntaxException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Built-in default masking patterns: always on, user patterns extend. Same vectors as Python. */
class DefaultMaskingTest {
  private static final ObjectMapper MAPPER = new ObjectMapper();

  @Test
  void defaultPatternListsAreVerbatim() {
    assertEquals(
        List.of("auth", "api.?key", "secret", "token", "password", "pwd"),
        Redactor.DEFAULT_MASK_QUERY_PARAMS);
    assertEquals(List.of("auth", "api.?key", "secret", "token", "cookie"), Redactor.DEFAULT_MASK_HEADER_PATTERNS);
    assertEquals(
        List.of("password", "pwd", "token", "secret", "auth", "card.?number", "ccv", "cvv", "cvc", "ssn"),
        Redactor.DEFAULT_MASK_BODY_FIELDS);
  }

  // ── Query params ──────────────────────────────────────────────────────────

  @ParameterizedTest
  @ValueSource(strings = {
      "auth", "api_key", "apikey", "api-key", "client_secret", "token", "access_token", "password", "pwd", "AUTH_CODE"})
  void defaultQueryParamPatterns(String name) {
    assertEquals(name + "=" + REDACTED + "&page=2", new Redactor().redactQuery(name + "=s3cr3t&page=2"));
  }

  @Test
  void tokenQueryRedactedWithNoUserConfig() {
    assertEquals("token=[redacted]", new Redactor().redactQuery("token=abc"));
  }

  @Test
  void queryWithoutSensitiveParamsIsUntouched() {
    String query = "q=hello%20world&page=2&tags=a+b";
    assertEquals(query, new Redactor().redactQuery(query));
  }

  @Test
  void userQueryPatternsExtendDefaults() {
    Redactor redactor = new Redactor(List.of("^card_number$"), List.of(), List.of());
    assertEquals(
        "card_number=" + REDACTED + "&token=" + REDACTED + "&page=1",
        redactor.redactQuery("card_number=4242&token=t&page=1"));
  }

  // ── Headers ───────────────────────────────────────────────────────────────

  @ParameterizedTest
  @ValueSource(strings = {"x-auth-user", "x-apikey", "x-api_key", "x-client-secret", "x-refresh-token", "x-session-cookie"})
  void defaultHeaderPatterns(String name) throws Exception {
    assertEquals(Map.of(name, REDACTED, "accept", "json"), headers(new Redactor(), Map.of(name, "v", "accept", "json")));
  }

  @Test
  void exactSensitiveHeadersStillApply() throws Exception {
    assertEquals(
        Map.of("x-amz-security-token", REDACTED, "set-cookie", REDACTED),
        headers(new Redactor(), Map.of("x-amz-security-token", "v", "set-cookie", "c")));
  }

  @Test
  void userHeaderPatternsExtendDefaults() throws Exception {
    Redactor redactor = new Redactor(List.of(), List.of("^x-internal$"), List.of());
    assertEquals(
        Map.of("x-internal", REDACTED, "x-auth", REDACTED, "accept", "json"),
        headers(redactor, Map.of("x-internal", "v", "x-auth", "a", "accept", "json")));
  }

  // ── Body fields ───────────────────────────────────────────────────────────

  @ParameterizedTest
  @ValueSource(strings = {
      "password", "pwd", "token", "client_secret", "auth", "card_number", "cardnumber", "ccv", "cvv", "cvc", "ssn"})
  void defaultBodyFieldPatterns(String field) throws Exception {
    String body = MAPPER.writeValueAsString(orderedMap(field, "x", "name", "Ada"));
    assertEquals(MAPPER.readTree("{\"" + field + "\":\"[redacted]\",\"name\":\"Ada\"}"), json(new Redactor().redactBody(body)));
  }

  @Test
  void bodyMasksNumbersAsWellAsStrings() throws Exception {
    String body = "{\"card_number\": 4242424242424242, \"cvv\": 123, \"ssn\": 1.5, \"amount\": 10}";
    assertEquals(
        json("{\"card_number\":\"[redacted]\",\"cvv\":\"[redacted]\",\"ssn\":\"[redacted]\",\"amount\":10}"),
        json(new Redactor().redactBody(body)));
  }

  @Test
  void bodyKeepsBooleansAndNull() {
    String body = "{\"token\": null, \"password_set\": true, \"user\": {\"auth\": false}}";
    assertSame(body, new Redactor().redactBody(body));
  }

  @Test
  void bodyMasksNestedObjectsAndArraysWhole() throws Exception {
    String body = "{\"auth\":{\"user\":\"u\"},\"tokens\":[\"a\",\"b\"],\"n\":1}";
    assertEquals(
        json("{\"auth\":\"[redacted]\",\"tokens\":\"[redacted]\",\"n\":1}"),
        json(new Redactor().redactBody(body)));
  }

  @Test
  void bodyNestedDefaults() throws Exception {
    String body = "{\"user\": {\"name\": \"Ada\", \"password\": \"p\"}, \"items\": [{\"cvc\": \"1\"}]}";
    assertEquals(
        json("{\"user\":{\"name\":\"Ada\",\"password\":\"[redacted]\"},\"items\":[{\"cvc\":\"[redacted]\"}]}"),
        json(new Redactor().redactBody(body)));
  }

  @Test
  void bodyWithoutSensitiveFieldsIsUntouchedByteForByte() {
    String body = "{ \"name\": \"Ada\",\n  \"amount\": 10 }";
    assertSame(body, new Redactor().redactBody(body));
  }

  @Test
  void userBodyPatternsExtendDefaults() throws Exception {
    Redactor redactor = new Redactor(List.of(), List.of(), List.of("^iban$"));
    assertEquals(
        json("{\"iban\":\"[redacted]\",\"password\":\"[redacted]\",\"n\":1}"),
        json(redactor.redactBody("{\"iban\":\"DE00\",\"password\":\"p\",\"n\":1}")));
  }

  @Test
  void formBodyUsesDefaults() {
    assertEquals("password=" + REDACTED + "&name=Ada", new Redactor().redactForm("password=p&name=Ada"));
  }

  @Test
  void invalidUserPatternFailsAtConstruction() {
    assertThrows(PatternSyntaxException.class, () -> new Redactor(List.of("("), List.of(), List.of()));
  }

  private static Map<String, Object> orderedMap(String k1, Object v1, String k2, Object v2) {
    Map<String, Object> map = new LinkedHashMap<>();
    map.put(k1, v1);
    map.put(k2, v2);
    return map;
  }

  private static JsonNode json(String value) throws Exception {
    return MAPPER.readTree(value);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, String> headers(Redactor redactor, Map<String, String> raw) throws Exception {
    return MAPPER.readValue(redactor.serializeHeaders(raw), Map.class);
  }
}
