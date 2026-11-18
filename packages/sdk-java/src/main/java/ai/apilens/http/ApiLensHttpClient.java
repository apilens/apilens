package ai.apilens.http;

import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;

/**
 * A {@link HttpClient} that turns each call made during a captured request into a child {@code
 * http} span and sends {@code traceparent} downstream. Wrap a client once with {@link #wrap} and
 * use the result everywhere; Spring Boot wraps {@code HttpClient} beans automatically.
 */
public final class ApiLensHttpClient extends HttpClient {
  private final HttpClient delegate;
  private final ApiLensHttpTracing tracing;

  private ApiLensHttpClient(HttpClient delegate, ApiLensHttpTracing tracing) {
    this.delegate = delegate;
    this.tracing = tracing;
  }

  /** Wraps {@code client}; a client that is already wrapped is returned as is. */
  public static HttpClient wrap(HttpClient client, ApiLensHttpTracing tracing) {
    if (client == null || client instanceof ApiLensHttpClient) {
      return client;
    }
    return new ApiLensHttpClient(client, tracing);
  }

  /** The wrapped client. */
  public HttpClient delegate() {
    return delegate;
  }

  @Override
  public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler)
      throws IOException, InterruptedException {
    ApiLensHttpTracing.OutboundSpan span = tracing.start(request.method(), request.uri());
    if (span == null) {
      return delegate.send(request, responseBodyHandler);
    }
    HttpResponse<T> response;
    try {
      response = delegate.send(withTraceparent(request, span), responseBodyHandler);
    } catch (IOException | InterruptedException | RuntimeException | Error ex) {
      span.end(0, ex);
      throw ex;
    }
    span.end(response.statusCode(), null);
    return response;
  }

  @Override
  public <T> CompletableFuture<HttpResponse<T>> sendAsync(
      HttpRequest request, HttpResponse.BodyHandler<T> responseBodyHandler) {
    return sendAsync(request, responseBodyHandler, null);
  }

  @Override
  public <T> CompletableFuture<HttpResponse<T>> sendAsync(
      HttpRequest request,
      HttpResponse.BodyHandler<T> responseBodyHandler,
      HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
    ApiLensHttpTracing.OutboundSpan span = tracing.start(request.method(), request.uri());
    if (span == null) {
      return delegate.sendAsync(request, responseBodyHandler, pushPromiseHandler);
    }
    CompletableFuture<HttpResponse<T>> future;
    try {
      future = delegate.sendAsync(withTraceparent(request, span), responseBodyHandler, pushPromiseHandler);
    } catch (RuntimeException | Error ex) {
      span.end(0, ex);
      throw ex;
    }
    return future.whenComplete((response, error) -> {
      if (error != null) {
        span.end(0, error);
      } else {
        span.end(response.statusCode(), null);
      }
    });
  }

  private static HttpRequest withTraceparent(HttpRequest request, ApiLensHttpTracing.OutboundSpan span) {
    if (request.headers().firstValue("traceparent").isPresent()) {
      return request;
    }
    return HttpRequest.newBuilder(request, (name, value) -> true)
        .header("traceparent", span.traceparent())
        .build();
  }

  @Override
  public Optional<CookieHandler> cookieHandler() {
    return delegate.cookieHandler();
  }

  @Override
  public Optional<Duration> connectTimeout() {
    return delegate.connectTimeout();
  }

  @Override
  public Redirect followRedirects() {
    return delegate.followRedirects();
  }

  @Override
  public Optional<ProxySelector> proxy() {
    return delegate.proxy();
  }

  @Override
  public SSLContext sslContext() {
    return delegate.sslContext();
  }

  @Override
  public SSLParameters sslParameters() {
    return delegate.sslParameters();
  }

  @Override
  public Optional<Authenticator> authenticator() {
    return delegate.authenticator();
  }

  @Override
  public Version version() {
    return delegate.version();
  }

  @Override
  public Optional<Executor> executor() {
    return delegate.executor();
  }

  @Override
  public WebSocket.Builder newWebSocketBuilder() {
    return delegate.newWebSocketBuilder();
  }
}
