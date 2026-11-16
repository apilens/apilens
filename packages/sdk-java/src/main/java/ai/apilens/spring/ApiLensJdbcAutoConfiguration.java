package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import ai.apilens.jdbc.ApiLensDataSource;
import ai.apilens.jdbc.ApiLensJdbcTracing;
import java.sql.Connection;
import javax.sql.DataSource;
import org.aopalliance.intercept.MethodInterceptor;
import org.aopalliance.intercept.MethodInvocation;
import org.springframework.aop.framework.Advised;
import org.springframework.aop.framework.AopConfigException;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

/**
 * Database child spans: wraps every {@code DataSource} bean so that statements run during a
 * captured request become {@code db} spans with obfuscated SQL ({@link ApiLensJdbcTracing}). The
 * wrapper is a subclass proxy where possible, so the bean keeps its type ({@code
 * HikariDataSource} stays injectable). With span capture off ({@code apilens.capture-spans=false})
 * the beans are left as they are.
 */
@AutoConfiguration(after = {ApiLensAutoConfiguration.class, ApiLensWebFluxAutoConfiguration.class})
@ConditionalOnClass(name = "org.springframework.aop.framework.ProxyFactory")
@EnableConfigurationProperties(ApiLensProperties.class)
public class ApiLensJdbcAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean
  @ConditionalOnBean(ApiLensClient.class)
  public ApiLensJdbcTracing apiLensJdbcTracing(
      ApiLensClient client,
      ApiLensProperties properties,
      ObjectProvider<ApiLensSpringOptionsCustomizer> optionsCustomizers) {
    ApiLensSpringOptions.Builder builder = properties.toSpringOptions().toBuilder();
    optionsCustomizers.orderedStream().forEach(customizer -> customizer.customize(builder));
    ApiLensSpringOptions options = builder.build();
    return new ApiLensJdbcTracing(client, options.environment(), options.serviceName(), options.captureSpans());
  }

  /** Wraps {@code DataSource} beans; resolved lazily so it never initialises the client early. */
  @Bean
  public static BeanPostProcessor apiLensDataSourcePostProcessor(ObjectProvider<ApiLensJdbcTracing> tracing) {
    return new BeanPostProcessor() {
      @Override
      public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (!(bean instanceof DataSource dataSource) || isTraced(bean)) {
          return bean;
        }
        ApiLensJdbcTracing value = tracing.getIfAvailable();
        if (value == null || !value.enabled()) {
          return bean;
        }
        return wrap(dataSource, value);
      }
    };
  }

  static Object wrap(DataSource dataSource, ApiLensJdbcTracing tracing) {
    ProxyFactory factory = new ProxyFactory(dataSource);
    factory.setProxyTargetClass(true);
    factory.addAdvice(new ConnectionInterceptor(tracing));
    try {
      return factory.getProxy(ApiLensJdbcAutoConfiguration.class.getClassLoader());
    } catch (AopConfigException | IllegalArgumentException | LinkageError ex) {
      // A final class (or one that cannot be subclassed): fall back to an interface proxy.
      return ApiLensDataSource.wrap(dataSource, tracing);
    }
  }

  private static boolean isTraced(Object bean) {
    if (ApiLensDataSource.isWrapped(bean)) {
      return true;
    }
    if (bean instanceof Advised advised) {
      for (var advisor : advised.getAdvisors()) {
        if (advisor.getAdvice() instanceof ConnectionInterceptor) {
          return true;
        }
      }
    }
    return false;
  }

  /** Hands out traced connections from {@code getConnection}. */
  static final class ConnectionInterceptor implements MethodInterceptor {
    private final ApiLensJdbcTracing tracing;

    ConnectionInterceptor(ApiLensJdbcTracing tracing) {
      this.tracing = tracing;
    }

    @Override
    public Object invoke(MethodInvocation invocation) throws Throwable {
      Object result = invocation.proceed();
      if (invocation.getMethod().getName().equals("getConnection") && result instanceof Connection connection) {
        return ApiLensDataSource.wrap(connection, tracing);
      }
      return result;
    }
  }
}
