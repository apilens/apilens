package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.micrometer.ApiLensMetrics;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Exposes {@link ApiLensClient#stats()} as Micrometer meters when Micrometer is on the
 * classpath. Spring Boot binds every {@code MeterBinder} bean to the application's registry.
 */
@AutoConfiguration(after = ApiLensAutoConfiguration.class)
@ConditionalOnClass(name = "io.micrometer.core.instrument.binder.MeterBinder")
public class ApiLensMetricsAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensClient.class)
  public ApiLensMetrics apiLensMetrics(ApiLensClient client) {
    return new ApiLensMetrics(client);
  }
}
