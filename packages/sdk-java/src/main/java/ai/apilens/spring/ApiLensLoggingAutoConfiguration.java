package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.logging.ApiLensLog4j2Appender;
import ai.apilens.logging.ApiLensLogbackAppender;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Ships exceptions the application logs at ERROR as {@code apilens.exception} logs: attaches
 * {@link ApiLensLogbackAppender} when Logback is the logging system and {@link
 * ApiLensLog4j2Appender} when Log4j2 is. {@code apilens.capture-logs=off} turns it off; the
 * default is {@code errors}.
 */
@AutoConfiguration(after = {ApiLensAutoConfiguration.class, ApiLensWebFluxAutoConfiguration.class})
@ConditionalOnProperty(prefix = "apilens", name = "capture-logs", havingValue = "errors", matchIfMissing = true)
public class ApiLensLoggingAutoConfiguration {
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(name = "ch.qos.logback.classic.LoggerContext")
  static class Logback {
    @Bean(destroyMethod = "detach")
    @ConditionalOnMissingBean
    @ConditionalOnBean(ApiLensClient.class)
    ApiLensLogbackAppender apiLensLogbackAppender(ApiLensClient client) {
      return ApiLensLogbackAppender.attach(client);
    }
  }

  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(name = "org.apache.logging.log4j.core.LoggerContext")
  static class Log4j2 {
    @Bean(destroyMethod = "detach")
    @ConditionalOnMissingBean
    @ConditionalOnBean(ApiLensClient.class)
    ApiLensLog4j2Appender apiLensLog4j2Appender(ApiLensClient client) {
      return ApiLensLog4j2Appender.attach(client);
    }
  }
}
