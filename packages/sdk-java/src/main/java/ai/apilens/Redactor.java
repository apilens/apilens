package ai.apilens;

import ai.apilens.internal.Strings;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.regex.Pattern;

/**
 * Redacts sensitive request data before it leaves the application.
 *
 * <p>The built-in {@code DEFAULT_MASK_*} patterns always apply and user-supplied patterns extend
 * them, never replace them. Every pattern is matched case-insensitively with
 * {@link java.util.regex.Matcher#find()} against the <em>name</em> of the query parameter, header
 * or JSON body field; use anchors for exact matches ({@code ^card_number$}). Patterns are compiled
 * once, in the constructor.
 */
public final class Redactor {
  public static final String REDACTED = "[redacted]";
  /** Stored in place of a whole body that a mask callback dropped (returned null) or failed on. */
  public static final String MASKED = "[masked]";
  private static final String FORM_URLENCODED = "application/x-www-form-urlencoded";
  private static final int MAX_HEADER_BYTES = 8192;
  private static final int MAX_BODY_DEPTH = 32;
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final List<String> SENSITIVE_HEADERS = List.of(
      "authorization",
      "proxy-authorization",
      "cookie",
      "set-cookie",
      "x-api-key",
      "api-key",
      "x-auth-token",
      "x-amz-security-token",
      "x-csrf-token");

  /** Query-parameter name patterns that are always masked. */
  public static final List<String> DEFAULT_MASK_QUERY_PARAMS =
      List.of("auth", "api.?key", "secret", "token", "password", "pwd");
  /** Header name patterns that are always masked, on top of the exact sensitive header names. */
  public static final List<String> DEFAULT_MASK_HEADER_PATTERNS =
      List.of("auth", "api.?key", "secret", "token", "cookie");
  /** JSON / form body field name patterns that are always masked. */
  public static final List<String> DEFAULT_MASK_BODY_FIELDS = List.of(
      "password", "pwd", "token", "secret", "auth", "card.?number", "ccv", "cvv", "cvc", "ssn");

  private final Pattern queryParams;
  private final Pattern headers;
  private final Pattern bodyFields;

  public Redactor() {
    this(List.of(), List.of(), List.of());
  }

  /**
   * @param queryParams extra query-parameter name patterns
   * @param headers extra header name patterns
   * @param bodyFields extra body field name patterns
   * @throws java.util.regex.PatternSyntaxException when a user pattern is not a valid regex
   */
  public Redactor(List<String> queryParams, List<String> headers, List<String> bodyFields) {
    this.queryParams = compile(DEFAULT_MASK_QUERY_PARAMS, queryParams);
    this.headers = compile(DEFAULT_MASK_HEADER_PATTERNS, headers);
    this.bodyFields = compile(DEFAULT_MASK_BODY_FIELDS, bodyFields);
  }

  /** Masks matching parameter values; a query with no matching name is returned unchanged. */
  public String redactQuery(String query) {
    if (Strings.isBlank(query)) {
      return query == null ? "" : query;
    }
    String[] pairs = query.split("&", -1);
    List<String> out = new ArrayList<>(pairs.length);
    for (String pair : pairs) {
      int index = pair.indexOf('=');
      String rawName = index >= 0 ? pair.substring(0, index) : pair;
      String decodedName = decodeComponent(rawName);
      if (matches(queryParams, decodedName)) {
        out.add(rawName + (index >= 0 ? "=" : "") + REDACTED);
      } else {
        out.add(pair);
      }
    }
    return String.join("&", out);
  }

  /**
   * Masks matching field values in a JSON body, recursively.
   *
   * <p>A matching field is masked when its value is a string or a number, and also when it is a
   * nested object or array (masked whole). Booleans and {@code null} carry no secret and stay
   * visible. A body with no matching field, and any non-JSON payload, is returned unchanged.
   */
  public String redactBody(String payload) {
    if (Strings.isBlank(payload)) {
      return payload == null ? "" : payload;
    }
    try {
      JsonNode root = MAPPER.readTree(payload);
      if (root == null || (!root.isObject() && !root.isArray())) {
        return payload;
      }
      boolean[] changed = {false};
      JsonNode redacted = redactNode(root, 0, changed);
      return changed[0] ? MAPPER.writeValueAsString(redacted) : payload;
    } catch (IOException ex) {
      return payload;
    }
  }

  /**
   * Masks an {@code application/x-www-form-urlencoded} body with the query redactor: a field is
   * redacted when its decoded name matches a query-param or a body-field pattern.
   */
  public String redactForm(String body) {
    if (Strings.isBlank(body)) {
      return body == null ? "" : body;
    }
    String[] pairs = body.split("&", -1);
    List<String> out = new ArrayList<>(pairs.length);
    for (String pair : pairs) {
      int index = pair.indexOf('=');
      String rawName = index >= 0 ? pair.substring(0, index) : pair;
      String decodedName = decodeComponent(rawName);
      if (matches(queryParams, decodedName) || matches(bodyFields, decodedName)) {
        out.add(rawName + (index >= 0 ? "=" : "") + REDACTED);
      } else {
        out.add(pair);
      }
    }
    return String.join("&", out);
  }

  /**
   * Turns captured body bytes into the payload string that is sent.
   *
   * <p>Only JSON ({@code application/json}, {@code +json}), {@code text/*} and
   * {@code application/x-www-form-urlencoded} bodies are captured; any other content type is
   * stored as the {@link #omittedPlaceholder placeholder} and the callback never sees it.
   *
   * <p>Order is fixed: the {@code masker} callback runs first on the raw bytes (truncated to
   * {@code maxBytes}), then the result is decoded and the regex masking is applied (form fields
   * via the query redactor, everything else via {@link #redactBody}). The callback can rewrite or
   * drop the body but can never switch the regex masking off.
   *
   * <p>Fail closed: if the callback returns {@code null} or throws, the whole body is stored as
   * {@link #MASKED}; the raw body is never sent in that case.
   */
  public <T> String maskBody(
      byte[] body,
      String contentType,
      BiFunction<? super T, byte[], byte[]> masker,
      T info,
      int maxBytes) {
    if (body == null || body.length == 0 || maxBytes <= 0) {
      return "";
    }
    if (!isCapturableContentType(contentType)) {
      return omittedPlaceholder(contentType, body.length);
    }
    byte[] captured = body.length > maxBytes ? Arrays.copyOf(body, maxBytes) : body;
    if (masker != null) {
      byte[] result;
      try {
        result = masker.apply(info, captured.clone());
      } catch (RuntimeException ex) {
        return MASKED;
      }
      if (result == null) {
        return MASKED;
      }
      captured = result;
    }
    String decoded = decodeUtf8Safe(captured, maxBytes);
    return FORM_URLENCODED.equals(mediaType(contentType)) ? redactForm(decoded) : redactBody(decoded);
  }

  /**
   * Whether a body of this content type is captured: JSON ({@code application/json} or a
   * {@code +json} suffix), {@code text/*} or {@code application/x-www-form-urlencoded}. A missing
   * content type is treated as {@code application/octet-stream} and is not captured.
   */
  public static boolean isCapturableContentType(String contentType) {
    String media = mediaType(contentType);
    return media.equals("application/json")
        || media.endsWith("+json")
        || media.startsWith("text/")
        || media.equals(FORM_URLENCODED);
  }

  /** The payload stored for a body that is not captured: {@code [<content-type>, N bytes omitted]}. */
  public static String omittedPlaceholder(String contentType, long size) {
    String media = mediaType(contentType);
    return "[" + (media.isEmpty() ? "application/octet-stream" : media) + ", " + Math.max(size, 0L) + " bytes omitted]";
  }

  private static String mediaType(String contentType) {
    String value = Strings.clean(contentType).toLowerCase(Locale.ROOT);
    int semicolon = value.indexOf(';');
    return semicolon >= 0 ? value.substring(0, semicolon).trim() : value;
  }

  public String serializeHeaders(Map<String, ?> rawHeaders) {
    if (rawHeaders == null || rawHeaders.isEmpty()) {
      return "";
    }
    Map<String, String> safe = new LinkedHashMap<>();
    rawHeaders.forEach((key, value) -> {
      String name = Strings.clean(key).toLowerCase(Locale.ROOT);
      if (name.isEmpty()) {
        return;
      }
      boolean sensitive = SENSITIVE_HEADERS.contains(name) || matches(headers, name);
      safe.put(name, sensitive ? REDACTED : headerValue(value));
    });
    return trimHeaderJson(safe);
  }

  public static String decodeUtf8Safe(byte[] bytes, int maxBytes) {
    if (bytes == null || bytes.length == 0 || maxBytes <= 0) {
      return "";
    }
    int length = Math.min(bytes.length, maxBytes);
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.IGNORE)
          .onUnmappableCharacter(CodingErrorAction.IGNORE)
          .decode(ByteBuffer.wrap(bytes, 0, length))
          .toString();
    } catch (Exception ex) {
      return new String(bytes, 0, length, StandardCharsets.UTF_8);
    }
  }

  private JsonNode redactNode(JsonNode node, int depth, boolean[] changed) {
    if (depth > MAX_BODY_DEPTH) {
      return node;
    }
    if (node.isObject()) {
      ObjectNode copy = MAPPER.createObjectNode();
      node.fields().forEachRemaining(entry -> {
        JsonNode child = entry.getValue();
        if (!child.isNull() && !child.isBoolean() && matches(bodyFields, entry.getKey())) {
          copy.set(entry.getKey(), TextNode.valueOf(REDACTED));
          changed[0] = true;
        } else {
          copy.set(entry.getKey(), redactNode(child, depth + 1, changed));
        }
      });
      return copy;
    }
    if (node.isArray()) {
      ArrayNode array = MAPPER.createArrayNode();
      for (JsonNode child : node) {
        array.add(redactNode(child, depth + 1, changed));
      }
      return array;
    }
    return node;
  }

  private String trimHeaderJson(Map<String, String> safe) {
    try {
      String json = MAPPER.writeValueAsString(safe);
      if (Strings.utf8Length(json) <= MAX_HEADER_BYTES) {
        return json;
      }
      safe.entrySet().stream()
          .sorted(Map.Entry.<String, String>comparingByValue(Comparator.comparingInt(String::length)).reversed())
          .map(Map.Entry::getKey)
          .toList()
          .forEach(name -> {
            if (Strings.utf8Length(writeQuietly(safe)) > MAX_HEADER_BYTES) {
              safe.remove(name);
            }
          });
      return writeQuietly(safe);
    } catch (IOException ex) {
      return "";
    }
  }

  private String writeQuietly(Map<String, String> value) {
    try {
      return MAPPER.writeValueAsString(value);
    } catch (IOException ex) {
      return "";
    }
  }

  /**
   * Combines the built-in and user patterns into ONE case-insensitive regex. Each source pattern
   * is validated on its own (so a bad user regex fails with a precise error) and wrapped in its own
   * non-capturing group so alternation cannot change its meaning.
   */
  private static Pattern compile(List<String> defaults, List<String> extra) {
    List<String> patterns = new ArrayList<>(defaults);
    if (extra != null) {
      extra.stream().filter(value -> !Strings.isBlank(value)).forEach(patterns::add);
    }
    StringBuilder union = new StringBuilder();
    for (String pattern : patterns) {
      Pattern.compile(pattern);
      if (union.length() > 0) {
        union.append('|');
      }
      union.append("(?:").append(pattern).append(')');
    }
    return Pattern.compile(union.toString(), Pattern.CASE_INSENSITIVE);
  }

  private static boolean matches(Pattern pattern, String name) {
    return name != null && pattern.matcher(name).find();
  }

  private static String decodeComponent(String value) {
    try {
      return URLDecoder.decode(value, StandardCharsets.UTF_8);
    } catch (Exception ex) {
      return value;
    }
  }

  private static String headerValue(Object value) {
    if (value == null) {
      return "";
    }
    if (value instanceof Iterable<?> iterable) {
      List<String> parts = new ArrayList<>();
      iterable.forEach(item -> parts.add(String.valueOf(item)));
      return String.join(", ", parts);
    }
    if (value.getClass().isArray()) {
      return String.valueOf(value);
    }
    if (value instanceof CharBuffer charBuffer) {
      return charBuffer.toString();
    }
    return String.valueOf(value);
  }
}
