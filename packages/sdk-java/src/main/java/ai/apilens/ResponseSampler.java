package ai.apilens;

/**
 * Response-stage sampling callback ({@code sampleOnResponse}), run after the handler returns.
 * {@link SampleDecision#UNDECIDED} keeps the prior decision. It cannot keep a request already
 * dropped at the request stage. Returning {@code null} or throwing counts as
 * {@link SampleDecision#UNDECIDED}.
 */
@FunctionalInterface
public interface ResponseSampler {
  SampleDecision sample(SampleResponseInfo response);
}
