package ai.apilens;

import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Per-request sampling decision shared by the framework integrations.
 *
 * <p>Sampling decides whether a request's <em>detail</em> (headers, bodies, span, error log) is
 * kept. The base request record is always sent; a sampled-out record carries
 * {@code sampled=false}, so metrics derived from records never change.
 *
 * <p>Order: {@code sampleOnRequest} runs first. {@link SampleDecision#KEEP} / {@link
 * SampleDecision#DROP} / a probability settle the request stage; {@link SampleDecision#UNDECIDED}
 * falls back to {@code sampleRate}. When a {@code sampleOnResponse} callback is set, that
 * {@code sampleRate} roll is deferred to the response stage so the response callback can still
 * keep the request (e.g. keep every error). {@code sampleOnResponse} never keeps a request the
 * request stage dropped; {@link SampleDecision#UNDECIDED} there keeps the prior decision.
 * Callback exceptions and {@code null} returns count as {@link SampleDecision#UNDECIDED}.
 */
public final class Sampler {
  private static final Logger LOGGER = Logger.getLogger("apilens");

  /** Where a request stands after the request stage. */
  public enum State {
    /** Detail is kept unless {@code sampleOnResponse} drops it. */
    IN,
    /** Detail is dropped; final. */
    OUT,
    /** Undecided: {@code sampleOnResponse}, then {@code sampleRate}, decide at the response. */
    PENDING
  }

  /**
   * The outcome of the request stage.
   *
   * @param state where the request stands
   * @param callback what {@code sampleOnRequest} returned (UNDECIDED when unset or it failed)
   */
  public record RequestDecision(State state, SampleDecision callback) {
    /** Whether the request body may still be needed (the request was not dropped). */
    public boolean mayKeep() {
      return state != State.OUT;
    }
  }

  private final double sampleRate;
  private final RequestSampler onRequest;
  private final ResponseSampler onResponse;
  private final DoubleSupplier random;
  private final AtomicBoolean requestWarned = new AtomicBoolean();
  private final AtomicBoolean responseWarned = new AtomicBoolean();

  public Sampler(double sampleRate, RequestSampler onRequest, ResponseSampler onResponse) {
    this(sampleRate, onRequest, onResponse, () -> ThreadLocalRandom.current().nextDouble());
  }

  /**
   * @param random returns uniformly distributed values in {@code [0.0, 1.0)}
   * @throws IllegalArgumentException when {@code sampleRate} is outside {@code [0.0, 1.0]}
   */
  public Sampler(
      double sampleRate,
      RequestSampler onRequest,
      ResponseSampler onResponse,
      DoubleSupplier random) {
    this.sampleRate = validateRate(sampleRate);
    this.onRequest = onRequest;
    this.onResponse = onResponse;
    this.random = random == null ? () -> ThreadLocalRandom.current().nextDouble() : random;
  }

  /**
   * Returns {@code sampleRate} unchanged when it is in {@code [0.0, 1.0]}.
   *
   * @throws IllegalArgumentException otherwise (including NaN)
   */
  public static double validateRate(double sampleRate) {
    if (!(sampleRate >= 0.0 && sampleRate <= 1.0)) {
      throw new IllegalArgumentException("sampleRate must be between 0.0 and 1.0, got " + sampleRate);
    }
    return sampleRate;
  }

  /**
   * Request stage. {@code info} is only built when a {@code sampleOnRequest} callback is set.
   */
  public RequestDecision onRequest(Supplier<RequestInfo> info) {
    SampleDecision callback = SampleDecision.UNDECIDED;
    if (onRequest != null) {
      callback = call(() -> onRequest.sample(info.get()), requestWarned, "sampleOnRequest");
    }
    if (!callback.isUndecided()) {
      return new RequestDecision(roll(callback) ? State.IN : State.OUT, callback);
    }
    if (onResponse != null) {
      return new RequestDecision(State.PENDING, callback);
    }
    return new RequestDecision(rollRate() ? State.IN : State.OUT, callback);
  }

  /**
   * Response stage: whether the request's detail is kept. {@code info} is only built when a
   * {@code sampleOnResponse} callback is set and the request stage did not drop the request.
   */
  public boolean onResponse(RequestDecision decision, Supplier<SampleResponseInfo> info) {
    if (decision == null || decision.state() == State.OUT) {
      return false;
    }
    if (onResponse != null) {
      SampleDecision callback =
          call(() -> onResponse.sample(info.get()), responseWarned, "sampleOnResponse");
      if (!callback.isUndecided()) {
        return roll(callback);
      }
    }
    return decision.state() == State.IN || rollRate();
  }

  private SampleDecision call(Supplier<SampleDecision> callback, AtomicBoolean warned, String name) {
    try {
      SampleDecision result = callback.get();
      return result == null ? SampleDecision.UNDECIDED : result;
    } catch (RuntimeException ex) {
      if (warned.compareAndSet(false, true)) {
        LOGGER.log(Level.WARNING, "API Lens " + name + " callback threw; treating it as UNDECIDED", ex);
      }
      return SampleDecision.UNDECIDED;
    }
  }

  private boolean roll(SampleDecision decision) {
    return switch (decision.kind()) {
      case KEEP -> true;
      case DROP -> false;
      case PROBABILITY -> chance(decision.probability());
      case UNDECIDED -> rollRate();
    };
  }

  private boolean rollRate() {
    return chance(sampleRate);
  }

  private boolean chance(double p) {
    if (p >= 1.0) {
      return true;
    }
    if (p <= 0.0) {
      return false;
    }
    return random.getAsDouble() < p;
  }
}
