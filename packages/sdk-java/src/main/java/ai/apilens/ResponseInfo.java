package ai.apilens;

import java.util.Map;

/**
 * What a {@code maskResponseBody} callback is told about the response: the originating
 * {@link RequestInfo}, the status code and the response headers (lower-cased names, unredacted).
 */
public record ResponseInfo(RequestInfo request, int statusCode, Map<String, String> headers) {
  public ResponseInfo {
    headers = headers == null ? Map.of() : Map.copyOf(headers);
  }

  /** The response {@code Content-Type} header, or an empty string. */
  public String contentType() {
    return headers.getOrDefault("content-type", "");
  }
}
