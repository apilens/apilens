package ai.apilens;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Request exclusions: skip capture entirely for health checks, probes and static
 * well-known files. Same built-in default lists and matching rules as the
 * Python and TypeScript SDKs.
 *
 * <p>Patterns are compiled once, at construction, so an invalid regex throws a
 * {@link java.util.regex.PatternSyntaxException} there and never per request.
 * Every pattern is case-insensitive and searched (unanchored unless it uses
 * {@code ^} / {@code $}) against the request path without the query string, so
 * {@code ^/health$} excludes {@code /health} but not {@code /healthz} or
 * {@code /api/health}.
 */
public final class RequestExcluder {
  /** Env var whose comma-separated patterns are added to the path patterns. */
  public static final String ENV_EXCLUDE_PATHS = "APILENS_EXCLUDE_PATHS";

  /** Env var whose comma-separated patterns are added to the user-agent patterns. */
  public static final String ENV_EXCLUDE_USER_AGENTS = "APILENS_EXCLUDE_USER_AGENTS";

  /** Built-in path patterns; turned off with {@code defaultExclusions=false}. */
  public static final List<String> DEFAULT_EXCLUDED_PATHS = List.of(
      "/_?healthz?$",
      "/_?health[-_]?checks?$",
      "/_?heart[-_]?beats?$",
      "/ping$",
      "/ready$",
      "/live$",
      "/favicon(?:-[\\w-]+)?\\.(?:ico|png|svg)$",
      "/apple-touch-icon(?:-[\\w-]+)?\\.png$",
      "/robots\\.txt$",
      "/sitemap\\.xml$",
      "/manifest\\.json$",
      "/site\\.webmanifest$",
      "/service-worker\\.js$",
      "/sw\\.js$",
      "/\\.well-known/");

  /** Built-in user-agent patterns (load balancer and orchestrator probes). */
  public static final List<String> DEFAULT_EXCLUDED_USER_AGENTS = List.of(
      "health[-_ ]?check",
      "microsoft-azure-application-lb",
      "googlehc",
      "kube-probe");

  private final List<Pattern> pathPatterns;
  private final List<Pattern> userAgentPatterns;

  /** Built-in defaults plus {@code APILENS_EXCLUDE_PATHS} / {@code APILENS_EXCLUDE_USER_AGENTS}. */
  public RequestExcluder() {
    this(List.of(), List.of(), true, true);
  }

  public RequestExcluder(
      Collection<String> excludePaths,
      Collection<String> excludeUserAgents,
      boolean defaultExclusions,
      boolean includeEnv) {
    this(excludePaths, excludeUserAgents, defaultExclusions,
        includeEnv ? System::getenv : name -> null);
  }

  RequestExcluder(
      Collection<String> excludePaths,
      Collection<String> excludeUserAgents,
      boolean defaultExclusions,
      Function<String, String> env) {
    List<String> paths = new ArrayList<>();
    if (defaultExclusions) {
      paths.addAll(DEFAULT_EXCLUDED_PATHS);
    }
    paths.addAll(splitPatterns(excludePaths));
    paths.addAll(splitPatterns(env.apply(ENV_EXCLUDE_PATHS)));

    List<String> userAgents = new ArrayList<>();
    if (defaultExclusions) {
      userAgents.addAll(DEFAULT_EXCLUDED_USER_AGENTS);
    }
    userAgents.addAll(splitPatterns(excludeUserAgents));
    userAgents.addAll(splitPatterns(env.apply(ENV_EXCLUDE_USER_AGENTS)));

    this.pathPatterns = compile(paths);
    this.userAgentPatterns = compile(userAgents);
  }

  /**
   * Normalizes a comma-separated pattern string. Blank entries are dropped; a
   * regex that needs a literal comma must be passed as a list entry instead.
   */
  public static List<String> splitPatterns(String value) {
    if (value == null) {
      return List.of();
    }
    return clean(List.of(value.split(",")));
  }

  /** Trims each entry and drops blanks. Entries are not split on commas. */
  public static List<String> splitPatterns(Collection<String> values) {
    if (values == null) {
      return List.of();
    }
    return clean(values);
  }

  public List<Pattern> pathPatterns() {
    return pathPatterns;
  }

  public List<Pattern> userAgentPatterns() {
    return userAgentPatterns;
  }

  /** True when {@code path} (query string ignored) matches any path pattern. */
  public boolean matchesPath(String path) {
    if (pathPatterns.isEmpty()) {
      return false;
    }
    String value = path == null || path.isEmpty() ? "/" : path;
    int q = value.indexOf('?');
    if (q != -1) {
      value = value.substring(0, q);
    }
    for (Pattern pattern : pathPatterns) {
      if (pattern.matcher(value).find()) {
        return true;
      }
    }
    return false;
  }

  /** True when a non-empty {@code userAgent} matches any user-agent pattern. */
  public boolean matchesUserAgent(String userAgent) {
    if (userAgentPatterns.isEmpty() || userAgent == null || userAgent.isEmpty()) {
      return false;
    }
    for (Pattern pattern : userAgentPatterns) {
      if (pattern.matcher(userAgent).find()) {
        return true;
      }
    }
    return false;
  }

  /** True when the request should bypass capture entirely. */
  public boolean shouldExclude(String path, String userAgent) {
    return matchesPath(path) || matchesUserAgent(userAgent);
  }

  private static List<String> clean(Collection<String> values) {
    List<String> out = new ArrayList<>();
    for (String value : values) {
      if (value == null) {
        continue;
      }
      String trimmed = value.trim();
      if (!trimmed.isEmpty()) {
        out.add(trimmed);
      }
    }
    return List.copyOf(out);
  }

  private static List<Pattern> compile(List<String> patterns) {
    List<Pattern> out = new ArrayList<>(patterns.size());
    for (String pattern : patterns) {
      out.add(Pattern.compile(pattern, Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE));
    }
    return List.copyOf(out);
  }
}
