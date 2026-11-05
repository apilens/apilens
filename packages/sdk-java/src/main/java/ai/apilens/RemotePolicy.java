package ai.apilens;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.DoubleSupplier;

/**
 * The app's remote capture policy, as answered by {@code POST /v1/heartbeat} and applied until
 * the next heartbeat (see {@link ApiLensClient#remotePolicy()}).
 *
 * <p>The policy only ever <em>narrows</em> what the SDK captures; every field is combined with
 * the local setting and the stricter one wins:
 *
 * <ul>
 *   <li>{@code enabled=false}: no request, span or log records are sent (heartbeats continue).
 *   <li>{@code sampleRate}: keeps that fraction of the requests the local sampler keeps; the
 *       others are sent as base records with {@code sampled=false}, like local sampling.
 *   <li>{@code captureHeaders}, {@code captureRequestBody}, {@code captureResponseBody}: {@code
 *       false} turns that part off; {@code true} never turns on what the local config has off.
 *   <li>{@code maxPayloadBytes}: the smaller of it and the local {@code maxPayloadBytes}; {@code
 *       null} leaves the local cap.
 * </ul>
 *
 * @param maxPayloadBytes cap on each captured body in bytes, or {@code null} for no remote cap
 */
public record RemotePolicy(
    boolean enabled,
    double sampleRate,
    boolean captureHeaders,
    boolean captureRequestBody,
    boolean captureResponseBody,
    Integer maxPayloadBytes) {
  /** What an app without a saved policy gets, and what applies before the first heartbeat. */
  public static final RemotePolicy CAPTURE_EVERYTHING = new RemotePolicy(true, 1.0, true, true, true, null);

  public RemotePolicy {
    if (!(sampleRate >= 0.0 && sampleRate <= 1.0)) {
      throw new IllegalArgumentException("sampleRate must be between 0.0 and 1.0, got " + sampleRate);
    }
    if (maxPayloadBytes != null && maxPayloadBytes < 0) {
      throw new IllegalArgumentException("maxPayloadBytes must not be negative");
    }
  }

  /**
   * Parses the {@code policy} object of a heartbeat response. Returns {@code null} when it is
   * missing a field or a field has the wrong type or range: the caller then keeps the previous
   * policy rather than guessing.
   */
  public static RemotePolicy fromJson(JsonNode policy) {
    if (policy == null || !policy.isObject()) {
      return null;
    }
    JsonNode enabled = policy.get("enabled");
    JsonNode rate = policy.get("sample_rate");
    JsonNode headers = policy.get("capture_headers");
    JsonNode requestBody = policy.get("capture_request_body");
    JsonNode responseBody = policy.get("capture_response_body");
    JsonNode maxBytes = policy.get("max_payload_bytes");
    if (!isBoolean(enabled) || rate == null || !rate.isNumber() || !isBoolean(headers)
        || !isBoolean(requestBody) || !isBoolean(responseBody)) {
      return null;
    }
    double sampleRate = rate.asDouble();
    if (!(sampleRate >= 0.0 && sampleRate <= 1.0)) {
      return null;
    }
    Integer cap = null;
    if (maxBytes != null && !maxBytes.isNull()) {
      if (!maxBytes.isIntegralNumber() || !maxBytes.canConvertToInt() || maxBytes.asInt() < 0) {
        return null;
      }
      cap = maxBytes.asInt();
    }
    return new RemotePolicy(
        enabled.asBoolean(), sampleRate, headers.asBoolean(), requestBody.asBoolean(),
        responseBody.asBoolean(), cap);
  }

  /** The body cap to use given the local {@code maxPayloadBytes}: never larger than it. */
  public int limitPayloadBytes(int localMaxPayloadBytes) {
    if (maxPayloadBytes == null) {
      return localMaxPayloadBytes;
    }
    return Math.min(localMaxPayloadBytes, maxPayloadBytes);
  }

  /**
   * Whether a request the local sampler kept is also kept by {@link #sampleRate()}. {@code
   * random} returns uniform draws in {@code [0, 1)} and is only called when {@code 0 < sampleRate
   * < 1}.
   */
  public boolean keeps(DoubleSupplier random) {
    if (sampleRate >= 1.0) {
      return true;
    }
    if (sampleRate <= 0.0) {
      return false;
    }
    return random.getAsDouble() < sampleRate;
  }

  /** The policy in its wire form (snake_case keys, {@code max_payload_bytes} may be null). */
  public Map<String, Object> toWire() {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("enabled", enabled);
    out.put("sample_rate", sampleRate);
    out.put("capture_headers", captureHeaders);
    out.put("capture_request_body", captureRequestBody);
    out.put("capture_response_body", captureResponseBody);
    out.put("max_payload_bytes", maxPayloadBytes);
    return out;
  }

  private static boolean isBoolean(JsonNode node) {
    return node != null && node.isBoolean();
  }
}
