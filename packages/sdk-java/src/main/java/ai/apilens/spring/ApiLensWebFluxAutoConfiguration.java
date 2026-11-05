package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

/**
 * Spring Boot auto-configuration for API Lens in reactive (WebFlux) applications: registers
 * {@link ApiLensWebFilter} as a {@code WebFilter} bean. It runs before {@link
 * ApiLensAutoConfiguration}, which then skips the servlet filter, so a reactive app that also
 * has the servlet API on its classpath is captured once.
 */
@AutoConfiguration(before = ApiLensAutoConfiguration.class)
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.REACTIVE)
@ConditionalOnClass(name = "org.springframework.web.server.WebFilter")
@EnableConfigurationProperties(ApiLensProperties.class)
public class ApiLensWebFluxAutoConfiguration {
  @Bean(destroyMethod = "shutdown")
  @ConditionalOnMissingBean
  @ConditionalOnProperty(prefix = "apilens", name = "api-key")
  public ApiLensClient apiLensClient(ApiLensProperties properties) {
    return new ApiLensClient(properties.toClientConfig());
  }

  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensClient.class)
  public ApiLensWebFilter apiLensWebFilter(
      ApiLensClient client,
      ApiLensProperties properties,
      ObjectProvider<ApiLensWebFluxConsumerResolver> consumerResolver,
      ObjectProvider<ApiLensSpringOptionsCustomizer> optionsCustomizers) {
    ApiLensSpringOptions.Builder options = properties.toSpringOptions().toBuilder();
    optionsCustomizers.orderedStream().forEach(customizer -> customizer.customize(options));
    ApiLensWebFilter filter = new ApiLensWebFilter(client, options.build(), consumerResolver.getIfAvailable());
    filter.setOrder(properties.getFilterOrder());
    return filter;
  }

  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensWebFilter.class)
  public ApiLensMetadataReporter apiLensWebFluxMetadataReporter(
      ApiLensClient client,
      ApiLensWebFilter filter,
      ObjectProvider<ApiLensWebFluxConsumerResolver> consumerResolver) {
    return new ApiLensMetadataReporter(client, filter, consumerResolver.getIfAvailable() != null);
  }
}
