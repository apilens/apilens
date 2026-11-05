package ai.apilens;

import java.util.Objects;

/**
 * What a {@link RequestSampler} or {@link ResponseSampler} returns: keep the request's detail
 * ({@link #KEEP}), drop it ({@link #DROP}), keep it with a probability ({@link #probability}),
 * or leave the decision to the prior stage / {@code sampleRate} ({@link #UNDECIDED}).
 *
 * <p>Sampling only ever drops detail (headers, bodies, span, error log). The base request record
 * is always sent, with {@code sampled=false}, so traffic, latency and error metrics stay exact.
 */
public final class SampleDecision {
  /** Keep the request's detail. */
  public static final SampleDecision KEEP = new SampleDecision(Kind.KEEP, 1.0);
  /** Drop the request's detail; only the base record is sent. */
  public static final SampleDecision DROP = new SampleDecision(Kind.DROP, 0.0);
  /** No opinion: fall back to the prior decision or to {@code sampleRate}. */
  public static final SampleDecision UNDECIDED = new SampleDecision(Kind.UNDECIDED, Double.NaN);

  /** The kind of a {@link SampleDecision}. */
  public enum Kind {
    KEEP,
    DROP,
    PROBABILITY,
    UNDECIDED
  }

  private final Kind kind;
  private final double probability;

  private SampleDecision(Kind kind, double probability) {
    this.kind = kind;
    this.probability = probability;
  }

  /**
   * Keep the request's detail with probability {@code p}, in {@code [0.0, 1.0]}.
   *
   * @throws IllegalArgumentException when {@code p} is outside {@code [0.0, 1.0]} or NaN
   */
  public static SampleDecision probability(double p) {
    if (!(p >= 0.0 && p <= 1.0)) {
      throw new IllegalArgumentException("sample probability must be between 0.0 and 1.0, got " + p);
    }
    return new SampleDecision(Kind.PROBABILITY, p);
  }

  /** {@link #KEEP} for {@code true}, {@link #DROP} for {@code false}. */
  public static SampleDecision of(boolean keep) {
    return keep ? KEEP : DROP;
  }

  public Kind kind() {
    return kind;
  }

  /** 1.0 for KEEP, 0.0 for DROP, the probability for PROBABILITY and NaN for UNDECIDED. */
  public double probability() {
    return probability;
  }

  public boolean isUndecided() {
    return kind == Kind.UNDECIDED;
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof SampleDecision that
        && kind == that.kind
        && Double.compare(probability, that.probability) == 0;
  }

  @Override
  public int hashCode() {
    return Objects.hash(kind, probability);
  }

  @Override
  public String toString() {
    return kind == Kind.PROBABILITY
        ? "SampleDecision.probability(" + probability + ")"
        : "SampleDecision." + kind;
  }
}
