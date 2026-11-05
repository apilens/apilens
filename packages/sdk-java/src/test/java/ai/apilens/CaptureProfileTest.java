package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.spring.ApiLensSpringOptions;
import org.junit.jupiter.api.Test;

class CaptureProfileTest {
  @Test
  void parsesNamesCaseInsensitively() {
    assertEquals(CaptureProfile.METADATA, CaptureProfile.parse(" Metadata "));
    assertEquals(CaptureProfile.REDACTED, CaptureProfile.parse("redacted"));
    assertEquals(CaptureProfile.FULL, CaptureProfile.parse("FULL"));
    assertEquals("metadata", CaptureProfile.METADATA.wireName());
    IllegalArgumentException error =
        assertThrows(IllegalArgumentException.class, () -> CaptureProfile.parse("verbose"));
    assertTrue(error.getMessage().contains("metadata/redacted/full"));
  }

  @Test
  void unsetProfileKeepsTheDefaults() {
    ApiLensSpringOptions options = ApiLensSpringOptions.builder().build();
    assertNull(options.captureProfile());
    assertTrue(options.captureHeaders());
    assertTrue(options.capturePayloads());
    assertTrue(options.logRequestBody());
    assertTrue(options.logResponseBody());
    assertEquals(ApiLensSpringOptions.DEFAULT_MAX_PAYLOAD_BYTES, options.maxPayloadBytes());
  }

  @Test
  void fullIsTheSameAsTheDefaults() {
    ApiLensSpringOptions options =
        ApiLensSpringOptions.builder().captureProfile(CaptureProfile.FULL).build();
    assertTrue(options.captureHeaders());
    assertTrue(options.logRequestBody());
    assertTrue(options.logResponseBody());
    assertEquals(65_536, options.maxPayloadBytes());
  }

  @Test
  void metadataTurnsOffHeadersAndBodies() {
    ApiLensSpringOptions options =
        ApiLensSpringOptions.builder().captureProfile(CaptureProfile.METADATA).build();
    assertEquals(CaptureProfile.METADATA, options.captureProfile());
    assertFalse(options.captureHeaders());
    assertFalse(options.logRequestBody());
    assertFalse(options.logResponseBody());
  }

  @Test
  void redactedCapturesHeadersAndBodiesWithA16KbCap() {
    ApiLensSpringOptions options = ApiLensSpringOptions.builder()
        .capturePayloads(false)
        .captureProfile(CaptureProfile.REDACTED)
        .build();
    assertTrue(options.captureHeaders());
    assertTrue(options.logRequestBody());
    assertTrue(options.logResponseBody());
    assertEquals(16 * 1024, options.maxPayloadBytes());
    // The explicit flag still wins.
    assertFalse(options.capturePayloads());
  }

  @Test
  void explicitFlagsWinOverThePreset() {
    ApiLensSpringOptions options = ApiLensSpringOptions.builder()
        .captureProfile(CaptureProfile.METADATA)
        .logRequestBody(true)
        .build();
    assertTrue(options.logRequestBody());
    assertFalse(options.logResponseBody());
    assertFalse(options.captureHeaders());

    ApiLensSpringOptions redacted = ApiLensSpringOptions.builder()
        .maxPayloadBytes(1024)
        .captureHeaders(false)
        .captureProfile(CaptureProfile.REDACTED)
        .build();
    assertEquals(1024, redacted.maxPayloadBytes());
    assertFalse(redacted.captureHeaders());
  }

  @Test
  void metadataWithExplicitCapturePayloadsKeepsBothBodies() {
    ApiLensSpringOptions options = ApiLensSpringOptions.builder()
        .captureProfile(CaptureProfile.METADATA)
        .capturePayloads(true)
        .build();
    assertTrue(options.capturePayloads());
    assertTrue(options.logRequestBody());
    assertTrue(options.logResponseBody());
    assertFalse(options.captureHeaders());
  }

  @Test
  void toBuilderKeepsUnsetFlagsUnsetSoALaterProfileApplies() {
    ApiLensSpringOptions base = ApiLensSpringOptions.builder().logRequestBody(true).build();
    ApiLensSpringOptions options = base.toBuilder().captureProfile(CaptureProfile.METADATA).build();
    assertTrue(options.logRequestBody());
    assertFalse(options.logResponseBody());
    assertFalse(options.captureHeaders());

    ApiLensSpringOptions cleared = options.toBuilder().captureProfile(null).build();
    assertTrue(cleared.captureHeaders());
    assertTrue(cleared.logResponseBody());
  }
}
