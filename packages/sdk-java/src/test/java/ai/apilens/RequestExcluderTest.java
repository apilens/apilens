package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.regex.PatternSyntaxException;
import org.junit.jupiter.api.Test;

class RequestExcluderTest {
  private static RequestExcluder excluder(List<String> paths, List<String> userAgents, boolean defaults) {
    return new RequestExcluder(paths, userAgents, defaults, name -> null);
  }

  @Test
  void defaultPathsExcludeHealthProbesAndStaticFiles() {
    RequestExcluder excluder = excluder(List.of(), List.of(), true);
    for (String path : List.of(
        "/health", "/healthz", "/_health", "/HEALTH", "/api/health", "/health-check",
        "/health_checks", "/healthcheck", "/heartbeat", "/heart-beats", "/ping", "/ready",
        "/live", "/favicon.ico", "/favicon-32x32.png", "/apple-touch-icon.png",
        "/apple-touch-icon-precomposed.png", "/robots.txt", "/sitemap.xml",
        "/manifest.json", "/site.webmanifest", "/service-worker.js", "/sw.js",
        "/.well-known/openid-configuration", "/health?verbose=1")) {
      assertTrue(excluder.matchesPath(path), path);
    }
    for (String path : List.of(
        "/", "/orders", "/orders/42", "/healthy-food", "/pings", "/readiness",
        "/lives/1", "/robots.txt.bak", "/api/users?next=/health")) {
      assertFalse(excluder.matchesPath(path), path);
    }
  }

  @Test
  void defaultUserAgentsExcludeLoadBalancerAndOrchestratorProbes() {
    RequestExcluder excluder = excluder(List.of(), List.of(), true);
    for (String ua : List.of(
        "ELB-HealthChecker/2.0", "Health Check", "health_check", "kube-probe/1.29",
        "GoogleHC/1.0", "Microsoft-Azure-Application-LB/AGW")) {
      assertTrue(excluder.matchesUserAgent(ua), ua);
    }
    assertFalse(excluder.matchesUserAgent("Mozilla/5.0"));
    assertFalse(excluder.matchesUserAgent("curl/8.4.0"));
    assertFalse(excluder.matchesUserAgent(""));
    assertFalse(excluder.matchesUserAgent(null));
  }

  @Test
  void defaultExclusionsCanBeTurnedOff() {
    RequestExcluder excluder = excluder(List.of(), List.of(), false);
    assertTrue(excluder.pathPatterns().isEmpty());
    assertTrue(excluder.userAgentPatterns().isEmpty());
    assertFalse(excluder.shouldExclude("/health", "kube-probe/1.29"));
  }

  @Test
  void customPatternsAreCaseInsensitiveSearchesAndAddedToDefaults() {
    RequestExcluder excluder = excluder(List.of("^/internal/", "^/status$"), List.of("uptimerobot"), true);
    assertTrue(excluder.matchesPath("/internal/metrics"));
    assertTrue(excluder.matchesPath("/INTERNAL/jobs"));
    assertTrue(excluder.matchesPath("/status"));
    assertFalse(excluder.matchesPath("/status/1"));
    assertFalse(excluder.matchesPath("/api/internal/x"));
    assertTrue(excluder.matchesPath("/health"));
    assertTrue(excluder.matchesUserAgent("Mozilla/5.0+(compatible; UptimeRobot/2.0)"));
    assertTrue(excluder.shouldExclude("/orders", "UptimeRobot"));
    assertTrue(excluder.shouldExclude("/status", "Mozilla/5.0"));
    assertFalse(excluder.shouldExclude("/orders", "Mozilla/5.0"));
  }

  @Test
  void customPatternsApplyWithDefaultsOff() {
    RequestExcluder excluder = excluder(List.of("^/health$"), List.of(), false);
    assertTrue(excluder.matchesPath("/health"));
    assertFalse(excluder.matchesPath("/healthz"));
    assertFalse(excluder.matchesPath("/api/health"));
    assertFalse(excluder.matchesUserAgent("kube-probe/1.29"));
  }

  @Test
  void envPatternsAreAddedOnTop() {
    Map<String, String> env = Map.of(RequestExcluder.ENV_EXCLUDE_PATHS, " ^/admin/ , ,/metrics$ ");
    RequestExcluder excluder = new RequestExcluder(List.of(), List.of(), false, env::get);
    assertEquals(2, excluder.pathPatterns().size());
    assertTrue(excluder.matchesPath("/admin/users"));
    assertTrue(excluder.matchesPath("/app/metrics"));
    assertFalse(excluder.matchesPath("/orders"));
  }

  @Test
  void splitPatternsTrimsAndDropsBlanks() {
    assertEquals(List.of("a", "b"), RequestExcluder.splitPatterns(" a, ,b ,"));
    assertEquals(List.of(), RequestExcluder.splitPatterns((String) null));
    assertEquals(List.of("x{1,3}"), RequestExcluder.splitPatterns(Arrays.asList(" x{1,3} ", "", null)));
  }

  @Test
  void invalidRegexFailsAtConstruction() {
    assertThrows(PatternSyntaxException.class, () -> excluder(List.of("(unclosed"), List.of(), true));
    assertThrows(PatternSyntaxException.class, () -> excluder(List.of(), List.of("[bad"), true));
  }
}
