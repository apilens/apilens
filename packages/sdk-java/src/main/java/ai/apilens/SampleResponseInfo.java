package ai.apilens;

/**
 * What a {@link ResponseSampler} is told about a finished request. It is only called for
 * requests the request stage did not drop.
 *
 * @param request the originating request ({@code path} without query, redacted {@code rawPath})
 * @param route the endpoint path: the route template when known (e.g. {@code /orders/{id}})
 * @param statusCode the response status code
 * @param responseTimeMs the handler time in milliseconds
 * @param consumer the attributed consumer, {@link ApiLensConsumer#empty()} when none
 * @param requestDecision what {@code sampleOnRequest} returned ({@link SampleDecision#UNDECIDED}
 *     when it is unset, returned {@code null} or threw)
 */
public record SampleResponseInfo(
    RequestInfo request,
    String route,
    int statusCode,
    double responseTimeMs,
    ApiLensConsumer consumer,
    SampleDecision requestDecision) {
  public SampleResponseInfo {
    route = route == null ? "" : route;
    consumer = consumer == null ? ApiLensConsumer.empty() : consumer;
    requestDecision = requestDecision == null ? SampleDecision.UNDECIDED : requestDecision;
  }
}
