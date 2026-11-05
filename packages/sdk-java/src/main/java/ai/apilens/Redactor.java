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

/** Redacts sensitive request data before it leaves the application. */
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

  private final List<Pattern> queryParams;
  private final List<Pattern> headers;
  private final List<Pattern> bodyFields;

  public Redactor() {
    this(List.of(), List.of(), List.of());
  }

  public Redactor(List<String> queryParams, List<String> headers, List<String> bodyFields) {
    this.queryParams = compile(queryParams);
    this.headers = compile(headers);
    this.bodyFields = compile(bodyFields);
  }

  public String redactQuery(String query) {
    if (Strings.isBlank(query) || queryParams.isEmpty()) {
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

  public String redactBody(String payload) {
    if (Strings.isBlank(payload) || bodyFields.isEmpty()) {
      return payload == null ? "" : payload;
    }
    try {
      JsonNode root = MAPPER.readTree(payload);
      if (!root.isObject() && !root.isArray()) {
        return payload;
      }
      JsonNode redacted = redactNode(root, 0);
      return MAPPER.writeValueAsString(redacted);
    } catch (IOException ex) {
      return payload;
    }
  }

  /**
   * Masks an {@code application/x-www-form-urlencoded} body with the query redactor: a field is
   * redacted when its decoded name matches a query-param or a body-field pattern.
   */
  public String redactForm(String body) {
    if (Strings.isBlank(body) || (queryParams.isEmpty() && bodyFields.isEmpty())) {
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

  private JsonNode redactNode(JsonNode node, int depth) {
    if (depth > MAX_BODY_DEPTH) {
      return node;
    }
    if (node.isObject()) {
      ObjectNode copy = ((ObjectNode) node).deepCopy();
      copy.fieldNames().forEachRemaining(name -> {
        JsonNode child = copy.get(name);
        copy.set(name, matches(bodyFields, name) ? TextNode.valueOf(REDACTED) : redactNode(child, depth + 1));
      });
      return copy;
    }
    if (node.isArray()) {
      ArrayNode array = MAPPER.createArrayNode();
      for (JsonNode child : node) {
        array.add(redactNode(child, depth + 1));
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

  private static List<Pattern> compile(List<String> values) {
    if (values == null || values.isEmpty()) {
      return List.of();
    }
    return values.stream()
        .filter(value -> !Strings.isBlank(value))
        .map(value -> Pattern.compile(value, Pattern.CASE_INSENSITIVE))
        .toList();
  }

  private static boolean matches(List<Pattern> patterns, String name) {
    if (patterns == null || patterns.isEmpty() || name == null) {
      return false;
    }
    return patterns.stream().anyMatch(pattern -> pattern.matcher(name).find());
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
