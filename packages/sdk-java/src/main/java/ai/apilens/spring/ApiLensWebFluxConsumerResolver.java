package ai.apilens.spring;

import ai.apilens.ApiLensConsumer;
import org.springframework.web.server.ServerWebExchange;

/**
 * Optional Spring bean for central consumer attribution in WebFlux apps; the reactive
 * counterpart of {@link ApiLensConsumerResolver}. It runs once the exchange has completed, so
 * the response status and headers are set.
 */
@FunctionalInterface
public interface ApiLensWebFluxConsumerResolver {
  ApiLensConsumer resolve(ServerWebExchange exchange);
}
