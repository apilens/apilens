package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.http.ApiLensClientHttpRequestInterceptor;
import ai.apilens.http.ApiLensExchangeFilterFunction;
import ai.apilens.http.ApiLensHttpClient;
import ai.apilens.http.ApiLensHttpTracing;
import java.net.http.HttpClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.client.RestClientCustomizer;
import org.springframework.boot.web.client.RestTemplateCustomizer;
import org.springframework.boot.web.reactive.function.client.WebClientCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Outbound HTTP child spans and {@code traceparent} propagation: adds the API Lens interceptor to
 * every {@code RestTemplateBuilder} / {@code RestClient.Builder}, the filter to every {@code
 * WebClient.Builder}, and wraps {@code java.net.http.HttpClient} beans. With span capture off
 * ({@code apilens.capture-spans=false}) calls pass through untouched.
 */
@AutoConfiguration(after = {ApiLensAutoConfiguration.class, ApiLensWebFluxAutoConfiguration.class})
@EnableConfigurationProperties(ApiLensProperties.class)
public class ApiLensHttpClientAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensClient.class)
  public ApiLensHttpTracing apiLensHttpTracing(
      ApiLensClient client,
      ApiLensProperties properties,
      ObjectProvider<ApiLensSpringOptionsCustomizer> optionsCustomizers) {
    ApiLensSpringOptions.Builder builder = properties.toSpringOptions().toBuilder();
    optionsCustomizers.orderedStream().forEach(customizer -> customizer.customize(builder));
    ApiLensSpringOptions options = builder.build();
    return new ApiLensHttpTracing(client, options.environment(), options.serviceName(), options.captureSpans());
  }

  /** Wraps {@code HttpClient} beans; resolved lazily so it never initialises the client early. */
  @Bean
  public static BeanPostProcessor apiLensHttpClientPostProcessor(ObjectProvider<ApiLensHttpTracing> tracing) {
    return new BeanPostProcessor() {
      @Override
      public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof HttpClient client && !(bean instanceof ApiLensHttpClient)) {
          ApiLensHttpTracing value = tracing.getIfAvailable();
          return value == null ? bean : ApiLensHttpClient.wrap(client, value);
        }
        return bean;
      }
    };
  }

  // Member classes are processed before this class's own @Bean methods, so they are conditioned
  // on the client (defined by an earlier auto-configuration), not on the tracing bean.
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnBean(ApiLensClient.class)
  @ConditionalOnClass(name = "org.springframework.http.client.ClientHttpRequestInterceptor")
  static class RestClients {
    @Bean
    RestTemplateCustomizer apiLensRestTemplateCustomizer(ApiLensHttpTracing tracing) {
      ApiLensClientHttpRequestInterceptor interceptor = new ApiLensClientHttpRequestInterceptor(tracing);
      return restTemplate -> restTemplate.getInterceptors().add(interceptor);
    }

    @Bean
    @ConditionalOnClass(name = "org.springframework.web.client.RestClient")
    RestClientCustomizer apiLensRestClientCustomizer(ApiLensHttpTracing tracing) {
      ApiLensClientHttpRequestInterceptor interceptor = new ApiLensClientHttpRequestInterceptor(tracing);
      return builder -> builder.requestInterceptor(interceptor);
    }
  }

  @Configuration(proxyBeanMethods = false)
  @ConditionalOnBean(ApiLensClient.class)
  @ConditionalOnClass(name = "org.springframework.web.reactive.function.client.WebClient")
  static class WebClients {
    @Bean
    WebClientCustomizer apiLensWebClientCustomizer(ApiLensHttpTracing tracing) {
      ApiLensExchangeFilterFunction filter = new ApiLensExchangeFilterFunction(tracing);
      return builder -> builder.filter(filter);
    }
  }
}
