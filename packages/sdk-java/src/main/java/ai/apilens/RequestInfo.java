package ai.apilens;

import java.util.Map;

/**
 * What a {@code maskRequestBody} callback is told about the request.
 *
 * <p>{@code path} is the request path without query string; {@code rawPath} is the exact URL
 * with sensitive query values already redacted. {@code headers} have lower-cased names and are
 * unredacted (the callback runs in-process, nothing has left the application yet).
 */
public record RequestInfo(String method, String path, String rawPath, Map<String, String> headers) {
  public RequestInfo {
    method = method == null ? "" : method;
    path = path == null ? "" : path;
    rawPath = rawPath == null ? "" : rawPath;
    headers = headers == null ? Map.of() : Map.copyOf(headers);
  }

  /** The request {@code Content-Type} header, or an empty string. */
  public String contentType() {
    return headers.getOrDefault("content-type", "");
  }

  /** The request {@code User-Agent} header, or an empty string. */
  public String userAgent() {
    return headers.getOrDefault("user-agent", "");
  }
}
