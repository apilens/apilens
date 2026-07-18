package ai.apilens.spring;

import ai.apilens.ApiLensConsumer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/** Optional Spring bean for central consumer attribution. */
@FunctionalInterface
public interface ApiLensConsumerResolver {
  ApiLensConsumer resolve(HttpServletRequest request, HttpServletResponse response);
}
