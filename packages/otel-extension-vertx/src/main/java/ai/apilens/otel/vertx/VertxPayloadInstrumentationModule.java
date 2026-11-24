package ai.apilens.otel.vertx;

import static io.opentelemetry.javaagent.extension.matcher.AgentElementMatchers.hasClassesNamed;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

import io.opentelemetry.javaagent.extension.instrumentation.InstrumentationModule;
import io.opentelemetry.javaagent.extension.instrumentation.TypeInstrumentation;
import io.opentelemetry.javaagent.extension.instrumentation.TypeTransformer;
import java.util.Arrays;
import java.util.List;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.matcher.ElementMatcher;

/**
 * Records Vert.x 5 HTTP request and response bodies and headers on the server span that the
 * agent's Netty instrumentation starts, as {@code apilens.request.body}, {@code
 * apilens.response.body}, {@code apilens.request.headers} and {@code apilens.response.headers}.
 * APILens turns them into the request's payload and headers and applies the project's privacy
 * rules before storing them; it never stores them as span attributes.
 *
 * <p>Disable with {@code -Dotel.instrumentation.apilens-vertx-payloads.enabled=false}.
 */
public final class VertxPayloadInstrumentationModule extends InstrumentationModule {

  public VertxPayloadInstrumentationModule() {
    super("apilens-vertx-payloads");
  }

  /** After the Netty and Vert.x instrumentations, whose server span this one annotates. */
  @Override
  public int order() {
    return 100;
  }

  @Override
  public ElementMatcher.Junction<ClassLoader> classLoaderMatcher() {
    return hasClassesNamed("io.vertx.core.http.impl.http1.Http1ServerResponse");
  }

  @Override
  public List<String> getAdditionalHelperClassNames() {
    return Arrays.asList(
        "ai.apilens.otel.vertx.PayloadCapture",
        "ai.apilens.otel.vertx.PayloadCapture$Exchange",
        "ai.apilens.otel.vertx.PayloadCapture$HeadersGetter");
  }

  @Override
  public List<TypeInstrumentation> typeInstrumentations() {
    return Arrays.asList(
        new RequestInstrumentation(),
        new ResponseInstrumentation(),
        new Http2RequestInstrumentation(),
        new Http2ResponseInstrumentation());
  }

  static final class RequestInstrumentation implements TypeInstrumentation {
    @Override
    public ElementMatcher<TypeDescription> typeMatcher() {
      return named("io.vertx.core.http.impl.http1.Http1ServerRequest");
    }

    @Override
    public void transform(TypeTransformer transformer) {
      transformer.applyAdviceToMethod(
          named("handleBegin").and(takesArguments(1)), getClass().getName() + "$BeginAdvice");
      transformer.applyAdviceToMethod(
          named("handleContent").and(takesArgument(0, named("io.vertx.core.buffer.Buffer"))),
          getClass().getName() + "$ContentAdvice");
    }

    @SuppressWarnings("unused")
    public static final class BeginAdvice {
      @Advice.OnMethodExit(suppress = Throwable.class)
      public static void onExit(
          @Advice.FieldValue("response") Object response,
          @Advice.FieldValue("request") Object request) {
        PayloadCapture.begin(response, request);
      }
    }

    @SuppressWarnings("unused")
    public static final class ContentAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(
          @Advice.FieldValue("response") Object response, @Advice.Argument(0) Object chunk) {
        PayloadCapture.requestChunk(response, chunk);
      }
    }
  }

  static final class ResponseInstrumentation implements TypeInstrumentation {
    @Override
    public ElementMatcher<TypeDescription> typeMatcher() {
      return named("io.vertx.core.http.impl.http1.Http1ServerResponse");
    }

    @Override
    public void transform(TypeTransformer transformer) {
      // The private funnels every public write/end overload goes through, once each.
      transformer.applyAdviceToMethod(
          named("write")
              .and(takesArguments(2))
              .and(takesArgument(0, named("io.netty.buffer.ByteBuf"))),
          getClass().getName() + "$WriteAdvice");
      transformer.applyAdviceToMethod(
          named("end")
              .and(takesArguments(2))
              .and(takesArgument(0, named("io.vertx.core.buffer.Buffer"))),
          getClass().getName() + "$EndAdvice");
    }

    @SuppressWarnings("unused")
    public static final class WriteAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(@Advice.This Object response, @Advice.Argument(0) Object chunk) {
        PayloadCapture.responseChunk(response, chunk);
      }
    }

    @SuppressWarnings("unused")
    public static final class EndAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(
          @Advice.This Object response,
          @Advice.Argument(0) Object chunk,
          @Advice.FieldValue("headers") Object headers) {
        PayloadCapture.end(response, chunk, headers);
      }
    }
  }

  /** HTTP/2 and HTTP/3 streams, which the agent does not trace: the span starts here. */
  static final class Http2RequestInstrumentation implements TypeInstrumentation {
    @Override
    public ElementMatcher<TypeDescription> typeMatcher() {
      return named("io.vertx.core.http.impl.HttpServerRequestImpl");
    }

    @Override
    public void transform(TypeTransformer transformer) {
      transformer.applyAdviceToMethod(
          named("handleHeaders")
              .and(takesArgument(0, named("io.vertx.core.http.impl.HttpRequestHead"))),
          getClass().getName() + "$HeadersAdvice");
      transformer.applyAdviceToMethod(
          named("handleData").and(takesArgument(0, named("io.vertx.core.buffer.Buffer"))),
          getClass().getName() + "$DataAdvice");
    }

    @SuppressWarnings("unused")
    public static final class HeadersAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static Object onEnter(
          @Advice.This Object request,
          @Advice.FieldValue("response") Object response,
          @Advice.Argument(0) Object head) {
        return PayloadCapture.h2Begin(request, response, head);
      }

      @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
      public static void onExit(@Advice.Enter Object scope) {
        PayloadCapture.h2Exit(scope);
      }
    }

    @SuppressWarnings("unused")
    public static final class DataAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(
          @Advice.FieldValue("response") Object response, @Advice.Argument(0) Object chunk) {
        PayloadCapture.requestChunk(response, chunk);
      }
    }
  }

  static final class Http2ResponseInstrumentation implements TypeInstrumentation {
    @Override
    public ElementMatcher<TypeDescription> typeMatcher() {
      return named("io.vertx.core.http.impl.HttpServerResponseImpl");
    }

    @Override
    public void transform(TypeTransformer transformer) {
      transformer.applyAdviceToMethod(
          named("write")
              .and(takesArguments(2))
              .and(takesArgument(0, named("io.vertx.core.buffer.Buffer")))
              .and(takesArgument(1, boolean.class)),
          getClass().getName() + "$WriteAdvice");
      transformer.applyAdviceToMethod(
          named("handleClose").or(named("handleReset")).and(takesArguments(1)),
          getClass().getName() + "$CloseAdvice");
    }

    @SuppressWarnings("unused")
    public static final class WriteAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(
          @Advice.This Object response,
          @Advice.Argument(0) Object chunk,
          @Advice.Argument(1) boolean end,
          @Advice.FieldValue("headersMap") Object headers,
          @Advice.FieldValue("status") Object status) {
        PayloadCapture.h2Write(response, chunk, end, headers, status);
      }
    }

    @SuppressWarnings("unused")
    public static final class CloseAdvice {
      @Advice.OnMethodEnter(suppress = Throwable.class)
      public static void onEnter(
          @Advice.This Object response,
          @Advice.FieldValue("ended") boolean ended,
          @Advice.FieldValue("headersMap") Object headers,
          @Advice.FieldValue("status") Object status) {
        PayloadCapture.h2Closed(response, ended, headers, status);
      }
    }
  }
}
