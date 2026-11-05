package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;

class SamplerTest {
  private static final RequestInfo REQUEST =
      new RequestInfo("GET", "/orders/1", "/orders/1?x=1", Map.of("user-agent", "curl/8"));
  private static final Supplier<RequestInfo> REQUEST_INFO = () -> REQUEST;

  private static Supplier<SampleResponseInfo> response(int status, SampleDecision requestDecision) {
    return () -> new SampleResponseInfo(
        REQUEST, "/orders/{id}", status, 12.5, ApiLensConsumer.empty(), requestDecision);
  }

  private static boolean sample(Sampler sampler, int status) {
    Sampler.RequestDecision decision = sampler.onRequest(REQUEST_INFO);
    return sampler.onResponse(decision, response(status, decision.callback()));
  }

  /** A PRNG that fails the test if it is consulted. */
  private static final DoubleSupplier NO_RANDOM = () -> {
    throw new AssertionError("random must not be consulted");
  };

  @Test
  void rateOneKeepsEverythingAndRateZeroDropsEverythingWithoutRolling() {
    Sampler all = new Sampler(1.0, null, null, NO_RANDOM);
    Sampler none = new Sampler(0.0, null, null, NO_RANDOM);
    for (int i = 0; i < 1_000; i++) {
      assertTrue(sample(all, 200));
      assertFalse(sample(none, 200));
    }
    assertEquals(Sampler.State.OUT, none.onRequest(REQUEST_INFO).state());
    assertFalse(none.onRequest(REQUEST_INFO).mayKeep());
  }

  @Test
  void sampleRateIsStatisticallyAccurateOver10kRequests() {
    for (double rate : new double[] {0.1, 0.25, 0.5, 0.9}) {
      Sampler sampler = new Sampler(rate, null, null);
      int kept = 0;
      int n = 10_000;
      for (int i = 0; i < n; i++) {
        if (sample(sampler, 200)) {
          kept++;
        }
      }
      // 5 standard deviations: a false failure is ~1 in 3.5 million runs.
      double tolerance = 5 * Math.sqrt(rate * (1 - rate) / n);
      assertEquals(rate, kept / (double) n, tolerance, "rate " + rate);
    }
  }

  @Test
  void probabilityDecisionsAreStatisticallyAccurate() {
    Sampler sampler = new Sampler(1.0, request -> SampleDecision.probability(0.2), null);
    int kept = 0;
    int n = 10_000;
    for (int i = 0; i < n; i++) {
      if (sample(sampler, 200)) {
        kept++;
      }
    }
    assertEquals(0.2, kept / (double) n, 5 * Math.sqrt(0.2 * 0.8 / n));
  }

  @Test
  void validatesRatesAndProbabilities() {
    assertThrows(IllegalArgumentException.class, () -> new Sampler(-0.01, null, null));
    assertThrows(IllegalArgumentException.class, () -> new Sampler(1.01, null, null));
    assertThrows(IllegalArgumentException.class, () -> new Sampler(Double.NaN, null, null));
    assertThrows(IllegalArgumentException.class, () -> SampleDecision.probability(-1));
    assertThrows(IllegalArgumentException.class, () -> SampleDecision.probability(1.5));
    assertThrows(IllegalArgumentException.class, () -> SampleDecision.probability(Double.NaN));
    assertEquals(SampleDecision.probability(0.5), SampleDecision.probability(0.5));
    assertSame(SampleDecision.KEEP, SampleDecision.of(true));
    assertSame(SampleDecision.DROP, SampleDecision.of(false));
  }

  @Test
  void requestCallbackKeepAndDropOverrideTheRate() {
    Sampler keep = new Sampler(0.0, request -> SampleDecision.KEEP, null, NO_RANDOM);
    Sampler drop = new Sampler(1.0, request -> SampleDecision.DROP, null, NO_RANDOM);
    assertTrue(sample(keep, 200));
    assertFalse(sample(drop, 200));
  }

  @Test
  void requestCallbackUndecidedOrNullFallsBackToTheRate() {
    assertTrue(sample(new Sampler(1.0, request -> SampleDecision.UNDECIDED, null, NO_RANDOM), 200));
    assertFalse(sample(new Sampler(0.0, request -> SampleDecision.UNDECIDED, null, NO_RANDOM), 200));
    assertTrue(sample(new Sampler(1.0, request -> null, null, NO_RANDOM), 200));
    assertFalse(sample(new Sampler(0.0, request -> null, null, NO_RANDOM), 200));
  }

  @Test
  void requestCallbackSeesTheRequest() {
    Sampler sampler = new Sampler(1.0, request -> {
      assertEquals("GET", request.method());
      assertEquals("/orders/1", request.path());
      assertEquals("curl/8", request.userAgent());
      return SampleDecision.DROP;
    }, null);
    assertFalse(sample(sampler, 200));
  }

  @Test
  void callbackExceptionsAreTreatedAsUndecided() {
    AtomicInteger calls = new AtomicInteger();
    RequestSampler throwingRequest = request -> {
      calls.incrementAndGet();
      throw new IllegalStateException("boom");
    };
    ResponseSampler throwingResponse = response -> {
      calls.incrementAndGet();
      throw new IllegalStateException("boom");
    };
    Sampler keep = new Sampler(1.0, throwingRequest, throwingResponse, NO_RANDOM);
    Sampler drop = new Sampler(0.0, throwingRequest, throwingResponse, NO_RANDOM);
    for (int i = 0; i < 3; i++) {
      assertTrue(sample(keep, 200));
      assertFalse(sample(drop, 200));
    }
    assertEquals(12, calls.get());
  }

  @Test
  void responseCallbackKeepsOnlyErrorsEvenAtRateZero() {
    Sampler sampler = new Sampler(
        0.0, null, response -> SampleDecision.of(response.statusCode() >= 500), NO_RANDOM);
    assertFalse(sample(sampler, 200));
    assertFalse(sample(sampler, 404));
    assertTrue(sample(sampler, 500));
    assertTrue(sample(sampler, 503));
  }

  @Test
  void responseCallbackUndecidedFallsBackToTheRateOrThePriorDecision() {
    ResponseSampler undecided = response -> SampleDecision.UNDECIDED;
    assertTrue(sample(new Sampler(1.0, null, undecided, NO_RANDOM), 200));
    assertFalse(sample(new Sampler(0.0, null, undecided, NO_RANDOM), 200));
    // Kept at the request stage, undecided at the response stage: stays kept.
    assertTrue(sample(new Sampler(0.0, request -> SampleDecision.KEEP, undecided, NO_RANDOM), 200));
    assertTrue(sample(new Sampler(0.0, request -> SampleDecision.KEEP, response -> null, NO_RANDOM), 200));
  }

  @Test
  void responseCallbackCanDropARequestKeptAtTheRequestStage() {
    Sampler sampler = new Sampler(
        1.0, request -> SampleDecision.KEEP, response -> SampleDecision.DROP, NO_RANDOM);
    assertFalse(sample(sampler, 200));
  }

  @Test
  void responseCallbackCannotKeepARequestDroppedAtTheRequestStage() {
    AtomicInteger responseCalls = new AtomicInteger();
    Sampler sampler = new Sampler(1.0, request -> SampleDecision.DROP, response -> {
      responseCalls.incrementAndGet();
      return SampleDecision.KEEP;
    }, NO_RANDOM);
    assertFalse(sample(sampler, 500));
    assertEquals(0, responseCalls.get(), "a dropped request is final");
  }

  @Test
  void responseCallbackSeesTheRequestDecisionAndResponse() {
    Sampler sampler = new Sampler(0.0, request -> SampleDecision.probability(1.0), response -> {
      assertEquals(SampleDecision.probability(1.0), response.requestDecision());
      assertEquals("/orders/{id}", response.route());
      assertEquals(201, response.statusCode());
      assertEquals(12.5, response.responseTimeMs());
      return SampleDecision.UNDECIDED;
    }, NO_RANDOM);
    assertTrue(sample(sampler, 201));
  }

  @Test
  void probabilityUsesTheRandomSource() {
    Sampler low = new Sampler(1.0, request -> SampleDecision.probability(0.3), null, () -> 0.29);
    Sampler high = new Sampler(1.0, request -> SampleDecision.probability(0.3), null, () -> 0.3);
    assertTrue(sample(low, 200));
    assertFalse(sample(high, 200));
    Sampler rate = new Sampler(0.3, null, null, () -> 0.31);
    assertFalse(sample(rate, 200));
  }

  @Test
  void requestInfoIsOnlyBuiltWhenACallbackNeedsIt() {
    Sampler sampler = new Sampler(1.0, null, null, NO_RANDOM);
    Sampler.RequestDecision decision = sampler.onRequest(() -> {
      throw new AssertionError("request info must not be built");
    });
    assertTrue(sampler.onResponse(decision, () -> {
      throw new AssertionError("response info must not be built");
    }));
  }
}
