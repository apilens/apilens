package ai.apilens;

/**
 * Request-stage sampling callback ({@code sampleOnRequest}), run before the handler and before
 * the request body is buffered. A request dropped here never has its body read by API Lens and
 * cannot be kept again at the response stage. Returning {@code null} or throwing counts as
 * {@link SampleDecision#UNDECIDED}.
 */
@FunctionalInterface
public interface RequestSampler {
  SampleDecision sample(RequestInfo request);
}
