package ai.apilens.spring;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Registers {@link ApiLensHandlerExceptionResolver} in Spring MVC apps captured by {@link
 * ApiLensSpringFilter}, so exceptions resolved by {@code @ExceptionHandler} / {@code
 * @ControllerAdvice} still ship with their stack. Skipped without Spring MVC on the classpath
 * (a plain servlet app has no handler exception resolvers). Matched by name, so the condition
 * never loads Spring MVC classes.
 */
@AutoConfiguration(after = ApiLensAutoConfiguration.class)
@ConditionalOnClass(name = "org.springframework.web.servlet.HandlerExceptionResolver")
@ConditionalOnBean(ApiLensSpringFilter.class)
public class ApiLensWebMvcAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean
  public ApiLensHandlerExceptionResolver apiLensHandlerExceptionResolver() {
    return new ApiLensHandlerExceptionResolver();
  }
}
