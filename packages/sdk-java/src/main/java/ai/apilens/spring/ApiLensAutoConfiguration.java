package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import jakarta.servlet.Filter;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;

/** Spring Boot auto-configuration for API Lens. */
@AutoConfiguration
@ConditionalOnClass({Filter.class, ApiLensSpringFilter.class})
@EnableConfigurationProperties(ApiLensProperties.class)
public class ApiLensAutoConfiguration {
  @Bean(destroyMethod = "shutdown")
  @ConditionalOnMissingBean
  @ConditionalOnProperty(prefix = "apilens", name = "api-key")
  public ApiLensClient apiLensClient(ApiLensProperties properties) {
    return new ApiLensClient(properties.toClientConfig());
  }

  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensClient.class)
  public ApiLensSpringFilter apiLensSpringFilter(
      ApiLensClient client,
      ApiLensProperties properties,
      ObjectProvider<ApiLensConsumerResolver> consumerResolver) {
    return new ApiLensSpringFilter(client, properties.toSpringOptions(), consumerResolver.getIfAvailable());
  }

  @Bean
  @ConditionalOnMissingBean(name = "apiLensFilterRegistration")
  @ConditionalOnBean(ApiLensSpringFilter.class)
  public FilterRegistrationBean<ApiLensSpringFilter> apiLensFilterRegistration(
      ApiLensSpringFilter filter,
      ApiLensProperties properties) {
    FilterRegistrationBean<ApiLensSpringFilter> registration = new FilterRegistrationBean<>(filter);
    registration.setOrder(properties.getFilterOrder());
    registration.setName("apiLensSpringFilter");
    return registration;
  }
}
