package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Runtime resources: reports the connection pool of every {@code DataSource} bean (HikariCP,
 * found behind Spring and SDK proxies) in the heartbeat's {@code pools}. Pools that have not
 * started yet are picked up once they do. With {@code apilens.capture-resources=false} the
 * client samples nothing, so the registration is inert.
 */
@AutoConfiguration(after = {
    ApiLensAutoConfiguration.class, ApiLensWebFluxAutoConfiguration.class, ApiLensJdbcAutoConfiguration.class})
public class ApiLensResourcesAutoConfiguration {
  /** Registers the {@code DataSource} beans once every singleton exists. */
  @Bean
  @ConditionalOnMissingBean(name = "apiLensDataSourcePools")
  @ConditionalOnBean(ApiLensClient.class)
  public SmartInitializingSingleton apiLensDataSourcePools(ApiLensClient client, ListableBeanFactory beans) {
    return () -> {
      Map<String, DataSource> dataSources = beans.getBeansOfType(DataSource.class, false, false);
      dataSources.forEach(client::registerDataSource);
    };
  }
}
