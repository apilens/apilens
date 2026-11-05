package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Client IP privacy: {@code captureIp} / {@code anonymizeIp}. Same vectors as the Python SDK. */
class IpPrivacyTest {
  private static final UnaryOperator<String> NO_ENV = name -> null;

  @ParameterizedTest
  @CsvSource(delimiter = '|', value = {
      "203.0.113.42|203.0.113.0",
      "10.1.2.255|10.1.2.0",
      "203.0.113.0|203.0.113.0",
      "' 198.51.100.7 '|198.51.100.0",
      "198.51.100.7:51234|198.51.100.0"})
  void anonymizeIpv4ZeroesLastOctet(String raw, String expected) {
    assertEquals(expected, IpPrivacy.anonymize(raw));
  }

  @ParameterizedTest
  @CsvSource(delimiter = '|', value = {
      "2001:db8:85a3:8d3:1319:8a2e:370:7348|2001:db8:85a3::",
      "2001:0db8:85a3:ffff::1|2001:db8:85a3::",
      "::1|::",
      "[2001:db8:abcd:12::1]:443|2001:db8:abcd::",
      "fe80::1:2:3:4%eth0|fe80::",
      "::ffff:203.0.113.42|203.0.113.0"})
  void anonymizeIpv6Keeps48Bits(String raw, String expected) {
    assertEquals(expected, IpPrivacy.anonymize(raw));
  }

  @ParameterizedTest
  @ValueSource(strings = {
      "", "   ", "unknown", "not-an-ip", "300.1.2.3", "1.2.3", "2001:db8::zz", "[2001:db8::1", "_hidden"})
  void anonymizeInvalidStringsAreDropped(String raw) {
    assertEquals("", IpPrivacy.anonymize(raw));
  }

  @Test
  void anonymizeTakesFirstEntryOfForwardedList() {
    assertEquals("203.0.113.0", IpPrivacy.anonymize("203.0.113.42, 10.0.0.1, 10.0.0.2"));
    assertEquals("2001:db8:1::", IpPrivacy.anonymize("2001:db8:1:2::9, 203.0.113.42"));
  }

  @Test
  void policyDefaultsKeepIpUnchanged() {
    assertEquals("203.0.113.42", IpPrivacy.apply("203.0.113.42", true, false, NO_ENV));
  }

  @Test
  void captureIpFalseDropsIpEvenWhenAnonymising() {
    assertEquals("", IpPrivacy.apply("203.0.113.42", false, false, NO_ENV));
    assertEquals("", IpPrivacy.apply("203.0.113.42", false, true, NO_ENV));
  }

  @Test
  void envCaptureIpFalseWinsOverCode() {
    assertEquals("", IpPrivacy.apply("203.0.113.42", true, false, env("APILENS_CAPTURE_IP", "false")));
  }

  @Test
  void envAnonymizeIpTrueWinsOverCode() {
    assertEquals("203.0.113.0", IpPrivacy.apply("203.0.113.42", true, false, env("APILENS_ANONYMIZE_IP", "1")));
  }

  @Test
  void envCannotLoosenCode() {
    UnaryOperator<String> env = Map.of("APILENS_CAPTURE_IP", "true", "APILENS_ANONYMIZE_IP", "false")::get;
    assertEquals("", IpPrivacy.apply("203.0.113.42", false, false, env));
    assertEquals("203.0.113.0", IpPrivacy.apply("203.0.113.42", true, true, env));
  }

  private static UnaryOperator<String> env(String name, String value) {
    return key -> key.equals(name) ? value : null;
  }
}
