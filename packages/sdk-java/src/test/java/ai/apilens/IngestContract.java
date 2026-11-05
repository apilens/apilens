package ai.apilens;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The ingest contract of {@code POST /v1/heartbeat} and {@code POST /v1/metadata}, read from the
 * repo's generated OpenAPI document ({@code api/openapi/apilens.v1.json}, produced from the Go
 * handlers in {@code internal/ingest}) plus the rules those handlers enforce beyond the schema
 * (no API key field at any depth, non-blank ids, size caps).
 */
public final class IngestContract {
  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final Path SPEC = Path.of("..", "..", "api", "openapi", "apilens.v1.json");
  /** Mirrors {@code maxHeartbeatStatsSize} in internal/ingest/heartbeat.go. */
  public static final int MAX_HEARTBEAT_STATS_BYTES = 16 << 10;
  /** Mirrors {@code maxMetadataConfigBytes} in internal/ingest/metadata.go. */
  public static final int MAX_METADATA_CONFIG_BYTES = 64 << 10;

  private static JsonNode spec;

  private IngestContract() {}

  /** Whether the OpenAPI document is available (it is in the monorepo checkout). */
  public static boolean available() {
    return Files.isRegularFile(SPEC);
  }

  static synchronized JsonNode spec() {
    if (spec == null) {
      try {
        spec = MAPPER.readTree(SPEC.toFile());
      } catch (IOException ex) {
        throw new IllegalStateException("cannot read " + SPEC.toAbsolutePath(), ex);
      }
    }
    return spec;
  }

  /** The schema of the request body of {@code POST path}. */
  public static JsonNode requestSchema(String path) {
    JsonNode op = spec().path("paths").path(path).path("post");
    return resolve(op.path("requestBody").path("content").path("application/json").path("schema"));
  }

  /** The schema of the 200 response of {@code POST path}. */
  public static JsonNode responseSchema(String path) {
    JsonNode op = spec().path("paths").path(path).path("post");
    return resolve(op.path("responses").path("200").path("content").path("application/json").path("schema"));
  }

  /** Violations of a heartbeat body against the schema and the handler's extra rules. */
  public static List<String> heartbeatViolations(JsonNode body) {
    List<String> out = validate(body, requestSchema("/v1/heartbeat"), "$");
    commonRules(body, out);
    String instance = body.path("instance_id").asText("").trim();
    if (instance.isEmpty() || instance.length() > 128) {
      out.add("$.instance_id: required, at most 128 characters");
    }
    if (body.has("pid") && body.get("pid").asLong() < 0) {
      out.add("$.pid: must not be negative");
    }
    if (body.has("stats") && body.get("stats").toString().getBytes().length > MAX_HEARTBEAT_STATS_BYTES) {
      out.add("$.stats: exceeds " + MAX_HEARTBEAT_STATS_BYTES + " bytes");
    }
    return out;
  }

  /** Violations of a metadata body against the schema and the handler's extra rules. */
  public static List<String> metadataViolations(JsonNode body) {
    List<String> out = validate(body, requestSchema("/v1/metadata"), "$");
    commonRules(body, out);
    if (body.has("config") && body.get("config").toString().getBytes().length > MAX_METADATA_CONFIG_BYTES) {
      out.add("$.config: exceeds " + MAX_METADATA_CONFIG_BYTES + " bytes");
    }
    if (body.path("routes").size() > ApiLensClient.MAX_METADATA_ROUTES) {
      out.add("$.routes: more than " + ApiLensClient.MAX_METADATA_ROUTES);
    }
    return out;
  }

  /** A heartbeat response with {@code policy}, checked against the documented response schema. */
  public static String heartbeatResponse(Map<String, Object> policy) {
    try {
      JsonNode node = MAPPER.valueToTree(Map.of("policy", policy));
      List<String> violations = validate(node, responseSchema("/v1/heartbeat"), "$");
      if (!violations.isEmpty()) {
        throw new IllegalArgumentException("not a valid heartbeat response: " + violations);
      }
      return MAPPER.writeValueAsString(node);
    } catch (IOException ex) {
      throw new IllegalStateException(ex);
    }
  }

  private static void commonRules(JsonNode body, List<String> out) {
    if (body.path("app_id").asText("").isBlank()) {
      out.add("$.app_id: must not be blank");
    }
    if (hasApiKeyField(body)) {
      out.add("$: carries an api_key field (rejected with 422)");
    }
  }

  static boolean hasApiKeyField(JsonNode node) {
    if (node.isObject()) {
      Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
      while (fields.hasNext()) {
        Map.Entry<String, JsonNode> field = fields.next();
        String name = field.getKey().toLowerCase(Locale.ROOT).replaceAll("[-_. ]", "");
        if (name.equals("apikey") || hasApiKeyField(field.getValue())) {
          return true;
        }
      }
    } else if (node.isArray()) {
      for (JsonNode item : node) {
        if (hasApiKeyField(item)) {
          return true;
        }
      }
    }
    return false;
  }

  private static JsonNode resolve(JsonNode schema) {
    JsonNode ref = schema.get("$ref");
    if (ref == null) {
      return schema;
    }
    String name = ref.asText().substring("#/components/schemas/".length());
    return spec().path("components").path("schemas").path(name);
  }

  /** The subset of JSON Schema the generated document uses. */
  private static List<String> validate(JsonNode value, JsonNode schema, String at) {
    List<String> out = new ArrayList<>();
    schema = resolve(schema);
    if (schema.isMissingNode()) {
      out.add(at + ": no schema in the OpenAPI document");
      return out;
    }
    JsonNode type = schema.get("type");
    if (type != null && !matchesType(value, type)) {
      out.add(at + ": expected " + type + ", got " + value.getNodeType());
      return out;
    }
    if (value.isTextual()) {
      int length = value.asText().length();
      if (schema.has("minLength") && length < schema.get("minLength").asInt()) {
        out.add(at + ": shorter than " + schema.get("minLength"));
      }
      if (schema.has("maxLength") && length > schema.get("maxLength").asInt()) {
        out.add(at + ": longer than " + schema.get("maxLength"));
      }
    }
    if (value.isNumber()) {
      if (schema.has("minimum") && value.asDouble() < schema.get("minimum").asDouble()) {
        out.add(at + ": below " + schema.get("minimum"));
      }
      if (schema.has("maximum") && value.asDouble() > schema.get("maximum").asDouble()) {
        out.add(at + ": above " + schema.get("maximum"));
      }
    }
    if (value.isObject()) {
      JsonNode properties = schema.path("properties");
      for (JsonNode required : schema.path("required")) {
        if (!value.has(required.asText())) {
          out.add(at + "." + required.asText() + ": required");
        }
      }
      boolean closed = schema.has("additionalProperties") && schema.get("additionalProperties").isBoolean()
          && !schema.get("additionalProperties").asBoolean();
      Iterator<Map.Entry<String, JsonNode>> fields = value.fields();
      while (fields.hasNext()) {
        Map.Entry<String, JsonNode> field = fields.next();
        JsonNode property = properties.get(field.getKey());
        if (property != null) {
          out.addAll(validate(field.getValue(), property, at + "." + field.getKey()));
        } else if (closed) {
          out.add(at + "." + field.getKey() + ": not allowed");
        }
      }
    }
    if (value.isArray() && schema.has("items")) {
      int i = 0;
      for (JsonNode item : value) {
        out.addAll(validate(item, schema.get("items"), at + "[" + i++ + "]"));
      }
    }
    return out;
  }

  private static boolean matchesType(JsonNode value, JsonNode type) {
    if (type.isArray()) {
      for (JsonNode t : type) {
        if (matchesType(value, t)) {
          return true;
        }
      }
      return false;
    }
    return switch (type.asText()) {
      case "string" -> value.isTextual();
      case "integer" -> value.isIntegralNumber();
      case "number" -> value.isNumber();
      case "boolean" -> value.isBoolean();
      case "object" -> value.isObject();
      case "array" -> value.isArray();
      case "null" -> value.isNull();
      default -> true;
    };
  }
}
