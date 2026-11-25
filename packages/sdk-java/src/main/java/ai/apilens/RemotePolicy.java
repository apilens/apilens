package ai.apilens;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 *   <li>{@code resources}: runtime resources sampling ({@link Resources}); it can stop sampling,
 *       lengthen the interval or skip collectors, never the reverse.
 * </ul>
 *
 * @param maxPayloadBytes cap on each captured body in bytes, or {@code null} for no remote cap
 * @param resources the {@code resources} part; {@link Resources#UNRESTRICTED} when absent
 */
public record RemotePolicy(
    boolean enabled,
    double sampleRate,
    boolean captureHeaders,
    boolean captureRequestBody,
    boolean captureResponseBody,
    Integer maxPayloadBytes,
    Resources resources) {
  /** What an app without a saved policy gets, and what applies before the first heartbeat. */
  public static final RemotePolicy CAPTURE_EVERYTHING = new RemotePolicy(true, 1.0, true, true, true, null);

  /** A policy without a {@code resources} part (resources sampling unrestricted). */
  public RemotePolicy(
      boolean enabled,
      double sampleRate,
      boolean captureHeaders,
      boolean captureRequestBody,
      boolean captureResponseBody,
      Integer maxPayloadBytes) {
    this(enabled, sampleRate, captureHeaders, captureRequestBody, captureResponseBody, maxPayloadBytes,
        Resources.UNRESTRICTED);
  }

  public RemotePolicy {
    if (resources == null) {
      resources = Resources.UNRESTRICTED;
    }
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
        responseBody.asBoolean(), cap, Resources.fromJson(policy.get("resources")));
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
    out.put("resources", resources.toWire());
    return out;
  }

  /**
   * The {@code resources} part of the policy. It only narrows the local config: {@code
   * enabled=false} stops sampling, the effective interval is the longer of the local one and
   * {@code minIntervalS}, and the listed collectors are skipped.
   *
   * @param minIntervalS shortest sampling interval the SDK may use, in seconds
   * @param disabledCollectors collectors to skip: {@code process.cpu}, {@code process.memory},
   *     {@code process.pss}, {@code container.cpu}, {@code container.memory}, {@code runtime},
   *     {@code pools}, {@code processes}
   */
  public record Resources(boolean enabled, int minIntervalS, Set<String> disabledCollectors) {
    /** Shortest interval ingest ever asks for; the SDK's own minimum. */
    public static final int FLOOR_INTERVAL_S = 15;
    /** Longest {@code min_interval_s} honoured (ingest caps it at the same value). */
    public static final int MAX_INTERVAL_S = 600;
    /** No remote restriction: what applies when the response has no {@code resources} part. */
    public static final Resources UNRESTRICTED = new Resources(true, FLOOR_INTERVAL_S, Set.of());

    public Resources {
      minIntervalS = Math.max(FLOOR_INTERVAL_S, Math.min(minIntervalS, MAX_INTERVAL_S));
      disabledCollectors = disabledCollectors == null ? Set.of() : Set.copyOf(disabledCollectors);
    }

    /**
     * Parses {@code policy.resources}. A missing or malformed part is {@link #UNRESTRICTED}:
     * the local config applies, and a bad field never widens it.
     */
    public static Resources fromJson(JsonNode node) {
      if (node == null || !node.isObject()) {
        return UNRESTRICTED;
      }
      JsonNode enabled = node.get("enabled");
      JsonNode interval = node.get("min_interval_s");
      JsonNode disabled = node.get("disabled_collectors");
      boolean on = enabled == null || !enabled.isBoolean() || enabled.asBoolean();
      int minInterval = interval != null && interval.isIntegralNumber() && interval.canConvertToInt()
          ? interval.asInt()
          : FLOOR_INTERVAL_S;
      Set<String> names = new LinkedHashSet<>();
      if (disabled != null && disabled.isArray()) {
        for (JsonNode name : disabled) {
          if (name.isTextual() && !name.asText().isBlank()) {
            names.add(name.asText().trim());
          }
        }
      }
      return new Resources(on, minInterval, names);
    }

    /** Whether collector {@code name} may run. */
    public boolean allows(String name) {
      return enabled && !disabledCollectors.contains(name);
    }

    public Map<String, Object> toWire() {
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("enabled", enabled);
      out.put("min_interval_s", minIntervalS);
      List<String> names = new ArrayList<>(disabledCollectors);
      names.sort(null);
      out.put("disabled_collectors", names);
      return out;
    }
  }

  private static boolean isBoolean(JsonNode node) {
    return node != null && node.isBoolean();
  }
}
