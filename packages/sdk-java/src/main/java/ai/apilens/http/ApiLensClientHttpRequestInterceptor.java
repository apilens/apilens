package ai.apilens.http;

import java.io.IOException;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

/**
 * Child {@code http} spans and {@code traceparent} propagation for {@code RestTemplate} and
 * {@code RestClient}. Spring Boot adds it to every builder-made client automatically; add it by
 * hand to a client created with {@code new RestTemplate()}.
 */
public final class ApiLensClientHttpRequestInterceptor implements ClientHttpRequestInterceptor {
  private final ApiLensHttpTracing tracing;

  public ApiLensClientHttpRequestInterceptor(ApiLensHttpTracing tracing) {
    this.tracing = tracing;
  }

  @Override
  public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution)
      throws IOException {
    ApiLensHttpTracing.OutboundSpan span = tracing.start(request.getMethod().name(), request.getURI());
    if (span == null) {
      return execution.execute(request, body);
    }
    if (!request.getHeaders().containsKey("traceparent")) {
      request.getHeaders().set("traceparent", span.traceparent());
    }
    ClientHttpResponse response;
    try {
      response = execution.execute(request, body);
    } catch (IOException | RuntimeException | Error ex) {
      span.end(0, ex);
      throw ex;
    }
    span.end(statusCode(response), null);
    return response;
  }

  private static int statusCode(ClientHttpResponse response) {
    try {
      return response.getStatusCode().value();
    } catch (IOException | RuntimeException ex) {
      return 0;
    }
  }
}
