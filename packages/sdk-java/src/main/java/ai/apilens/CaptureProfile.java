package ai.apilens;

import java.util.Locale;

/**
 * Capture presets: one greppable setting for a capture posture. Same names and semantics as the
 * Python ({@code capture_profile}) and TypeScript ({@code captureProfile}) SDKs.
 *
 * <p>A preset only fills the capture flags left unset ({@code captureHeaders},
 * {@code capturePayloads}, {@code logRequestBody}, {@code logResponseBody},
 * {@code maxPayloadBytes}), so an individual flag always wins over it. The built-in masking
 * applies under every profile.
 */
public enum CaptureProfile {
  /**
   * Method, path, status, latency, sizes and consumer only: no headers and no bodies. Recommended
   * for a first production rollout.
   */
  METADATA,
  /** Headers and bodies on, masked by the built-in patterns, bodies capped at 16 KB. */
  REDACTED,
  /** The defaults: same as leaving the profile unset. */
  FULL;

  /** Body cap applied by {@link #REDACTED} (16 KB). */
  public static final int REDACTED_MAX_PAYLOAD_BYTES = 16 * 1024;

  /** The lower-case name used in config and env vars, e.g. {@code "metadata"}. */
  public String wireName() {
    return name().toLowerCase(Locale.ROOT);
  }

  /**
   * Parses {@code metadata} / {@code redacted} / {@code full}, case-insensitively.
   *
   * @throws IllegalArgumentException for any other value
   */
  public static CaptureProfile parse(String value) {
    String raw = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    for (CaptureProfile profile : values()) {
      if (profile.wireName().equals(raw)) {
        return profile;
      }
    }
    throw new IllegalArgumentException(
        "captureProfile: expected one of metadata/redacted/full, got \"" + value + "\"");
  }

  /** The effective capture flags after applying a profile to the explicitly set ones. */
  public record Resolved(
      boolean captureHeaders,
      boolean capturePayloads,
      boolean logRequestBody,
      boolean logResponseBody,
      int maxPayloadBytes) {}

  /**
   * Fills every {@code null} flag from {@code profile} (may be {@code null}), then from the
   * defaults ({@code true} / {@code defaultMaxPayloadBytes}). Under {@link #METADATA}, an explicit
   * {@code capturePayloads=true} asks for both bodies, so the preset's body flags are not applied.
   */
  public static Resolved resolve(
      CaptureProfile profile,
      Boolean captureHeaders,
      Boolean capturePayloads,
      Boolean logRequestBody,
      Boolean logResponseBody,
      Integer maxPayloadBytes,
      int defaultMaxPayloadBytes) {
    Boolean presetHeaders = null;
    Boolean presetPayloads = null;
    Boolean presetBodies = null;
    Integer presetMax = null;
    if (profile == METADATA) {
      presetHeaders = Boolean.FALSE;
      presetBodies = Boolean.TRUE.equals(capturePayloads) ? null : Boolean.FALSE;
    } else if (profile == REDACTED) {
      presetHeaders = Boolean.TRUE;
      presetPayloads = Boolean.TRUE;
      presetBodies = Boolean.TRUE;
      presetMax = REDACTED_MAX_PAYLOAD_BYTES;
    }
    return new Resolved(
        first(captureHeaders, presetHeaders),
        first(capturePayloads, presetPayloads),
        first(logRequestBody, presetBodies),
        first(logResponseBody, presetBodies),
        maxPayloadBytes != null ? maxPayloadBytes : presetMax != null ? presetMax : defaultMaxPayloadBytes);
  }

  private static boolean first(Boolean explicit, Boolean preset) {
    if (explicit != null) {
      return explicit;
    }
    return preset == null || preset;
  }
}
