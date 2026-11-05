package ai.apilens;

import java.util.Locale;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * Client IP privacy: {@code captureIp=false} drops the IP entirely, {@code anonymizeIp=true}
 * truncates IPv4 to its /24 (last octet zeroed) and IPv6 to its /48.
 *
 * <p>The {@code APILENS_CAPTURE_IP=false} and {@code APILENS_ANONYMIZE_IP=true} environment
 * variables can only tighten what the code configures, never loosen it.
 */
public final class IpPrivacy {
  private static final Set<String> TRUTHY = Set.of("1", "true", "yes", "on", "enabled");
  private static final Set<String> FALSEY = Set.of("0", "false", "no", "off", "disabled");

  private IpPrivacy() {}

  /**
   * Returns the client IP to record under the capture/anonymise options, honouring the
   * {@code APILENS_CAPTURE_IP} / {@code APILENS_ANONYMIZE_IP} environment variables.
   */
  public static String apply(String ipAddress, boolean captureIp, boolean anonymize) {
    return apply(ipAddress, captureIp, anonymize, System::getenv);
  }

  static String apply(String ipAddress, boolean captureIp, boolean anonymize, UnaryOperator<String> env) {
    if (!captureIp || !envCaptureIpEnabled(env)) {
      return "";
    }
    if (anonymize || envAnonymizeIpEnabled(env)) {
      return anonymize(ipAddress);
    }
    return ipAddress == null ? "" : ipAddress;
  }

  /** Whether client IPs are captured under {@code captureIp} and {@code APILENS_CAPTURE_IP}. */
  public static boolean effectiveCaptureIp(boolean captureIp) {
    return captureIp && envCaptureIpEnabled(System::getenv);
  }

  /** Whether captured IPs are anonymised under {@code anonymize} and {@code APILENS_ANONYMIZE_IP}. */
  public static boolean effectiveAnonymizeIp(boolean anonymize) {
    return anonymize || envAnonymizeIpEnabled(System::getenv);
  }

  static boolean envCaptureIpEnabled(UnaryOperator<String> env) {
    String raw = env.apply("APILENS_CAPTURE_IP");
    return raw == null || !FALSEY.contains(raw.strip().toLowerCase(Locale.ROOT));
  }

  static boolean envAnonymizeIpEnabled(UnaryOperator<String> env) {
    String raw = env.apply("APILENS_ANONYMIZE_IP");
    return raw != null && TRUTHY.contains(raw.strip().toLowerCase(Locale.ROOT));
  }

  /**
   * Truncates a client IP: IPv4 keeps its /24, IPv6 its /48. IPv4-mapped IPv6
   * ({@code ::ffff:1.2.3.4}) is treated as IPv4. Accepts the first entry of an
   * {@code X-Forwarded-For} list, {@code 1.2.3.4:5678}, {@code [2001:db8::1]:443} and zone ids
   * ({@code fe80::1%eth0}). A value that is not a parseable IP returns {@code ""}: it cannot be
   * anonymised safely, so it is dropped rather than sent as-is. Never does a DNS lookup.
   */
  public static String anonymize(String raw) {
    String value = raw == null ? "" : raw;
    int comma = value.indexOf(',');
    if (comma >= 0) {
      value = value.substring(0, comma);
    }
    value = value.strip();
    if (value.isEmpty()) {
      return "";
    }
    if (value.startsWith("[")) {
      int end = value.indexOf(']');
      if (end < 0) {
        return "";
      }
      value = value.substring(1, end);
    } else if (value.indexOf(':') >= 0 && value.indexOf(':') == value.lastIndexOf(':')) {
      // IPv4 with a port; a bare IPv6 address always has 2+ colons.
      value = value.substring(0, value.indexOf(':'));
    }
    int zone = value.indexOf('%');
    if (zone >= 0) {
      value = value.substring(0, zone);
    }
    int[] v4 = parseIpv4(value);
    if (v4 != null) {
      return v4[0] + "." + v4[1] + "." + v4[2] + ".0";
    }
    int[] v6 = parseIpv6(value);
    if (v6 == null) {
      return "";
    }
    if (isIpv4Mapped(v6)) {
      return (v6[6] >> 8) + "." + (v6[6] & 0xff) + "." + (v6[7] >> 8) + ".0";
    }
    for (int i = 3; i < 8; i++) {
      v6[i] = 0;
    }
    return formatIpv6(v6);
  }

  /** Strict dotted-quad parse: four decimal octets 0-255, no leading zeros. */
  private static int[] parseIpv4(String value) {
    String[] parts = value.split("\\.", -1);
    if (parts.length != 4) {
      return null;
    }
    int[] out = new int[4];
    for (int i = 0; i < 4; i++) {
      String part = parts[i];
      if (part.isEmpty() || part.length() > 3 || (part.length() > 1 && part.charAt(0) == '0')) {
        return null;
      }
      for (int j = 0; j < part.length(); j++) {
        char c = part.charAt(j);
        if (c < '0' || c > '9') {
          return null;
        }
      }
      int octet = Integer.parseInt(part);
      if (octet > 255) {
        return null;
      }
      out[i] = octet;
    }
    return out;
  }

  /** Parses an IPv6 literal (optionally ending in a dotted quad) into eight 16-bit groups. */
  private static int[] parseIpv6(String value) {
    if (value.indexOf(':') < 0) {
      return null;
    }
    String text = value;
    int[] tail = null;
    int lastColon = text.lastIndexOf(':');
    if (text.indexOf('.', lastColon) >= 0) {
      tail = parseIpv4(text.substring(lastColon + 1));
      if (tail == null) {
        return null;
      }
      text = text.substring(0, lastColon + 1) + "0:0";
    }
    int doubleColon = text.indexOf("::");
    if (doubleColon >= 0 && text.indexOf("::", doubleColon + 1) >= 0) {
      return null;
    }
    String head = doubleColon >= 0 ? text.substring(0, doubleColon) : text;
    String rest = doubleColon >= 0 ? text.substring(doubleColon + 2) : "";
    int[] headGroups = parseGroups(head);
    int[] restGroups = parseGroups(rest);
    if (headGroups == null || restGroups == null) {
      return null;
    }
    int count = headGroups.length + restGroups.length;
    if (doubleColon < 0 ? count != 8 : count > 7) {
      return null;
    }
    int[] groups = new int[8];
    System.arraycopy(headGroups, 0, groups, 0, headGroups.length);
    System.arraycopy(restGroups, 0, groups, 8 - restGroups.length, restGroups.length);
    if (tail != null) {
      groups[6] = (tail[0] << 8) | tail[1];
      groups[7] = (tail[2] << 8) | tail[3];
    }
    return groups;
  }

  private static int[] parseGroups(String text) {
    if (text.isEmpty()) {
      return new int[0];
    }
    String[] parts = text.split(":", -1);
    int[] out = new int[parts.length];
    for (int i = 0; i < parts.length; i++) {
      String part = parts[i];
      if (part.isEmpty() || part.length() > 4) {
        return null;
      }
      for (int j = 0; j < part.length(); j++) {
        if (Character.digit(part.charAt(j), 16) < 0) {
          return null;
        }
      }
      out[i] = Integer.parseInt(part, 16);
    }
    return out;
  }

  private static boolean isIpv4Mapped(int[] groups) {
    for (int i = 0; i < 5; i++) {
      if (groups[i] != 0) {
        return false;
      }
    }
    return groups[5] == 0xffff;
  }

  /** RFC 5952 text form: lower-case hex, the first longest run of 2+ zero groups as "::". */
  private static String formatIpv6(int[] groups) {
    int bestStart = -1;
    int bestLength = 0;
    int i = 0;
    while (i < 8) {
      if (groups[i] != 0) {
        i++;
        continue;
      }
      int start = i;
      while (i < 8 && groups[i] == 0) {
        i++;
      }
      if (i - start > bestLength) {
        bestStart = start;
        bestLength = i - start;
      }
    }
    if (bestLength < 2) {
      bestStart = -1;
    }
    StringBuilder out = new StringBuilder();
    for (int g = 0; g < 8; g++) {
      if (g == bestStart) {
        out.append("::");
        g += bestLength - 1;
        continue;
      }
      if (out.length() > 0 && out.charAt(out.length() - 1) != ':') {
        out.append(':');
      }
      out.append(Integer.toHexString(groups[g]));
    }
    return out.toString();
  }
}
