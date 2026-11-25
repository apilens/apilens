package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.ApiLensClient;
import ai.apilens.jdbc.ApiLensDataSource;
import ai.apilens.jdbc.ApiLensJdbcTracing;
import ai.apilens.resources.DataSourcePools;
import ai.apilens.resources.ResourceSampler;
import com.zaxxer.hikari.HikariDataSource;
import java.sql.Connection;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.aop.support.AopUtils;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.MapPropertySource;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/** HikariCP pools (H2) reach the heartbeat's {@code pools}, behind every kind of wrapper. */
class HikariPoolsSpringTest {
  private static HikariDataSource hikari(String name) {
    HikariDataSource ds = new HikariDataSource();
    ds.setJdbcUrl("jdbc:h2:mem:" + name + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
    ds.setMaximumPoolSize(4);
    ds.setMinimumIdle(1);
    ds.setPoolName(name);
    return ds;
  }

  private static List<Map<String, Object>> pools(DataSourcePools pools) {
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(pools));
    sampler.sampleNow();
    Map<String, Object> block = sampler.drain();
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> out = (List<Map<String, Object>>) block.get("pools");
    return out;
  }

  @Test
  void springDataSourceBeansAreReportedThroughTheirProxies() throws Exception {
    Map<String, Object> properties = new HashMap<>(Map.of(
        "apilens.api-key", "test-key",
        "apilens.app-id", "orders-api",
        "apilens.base-url", "http://127.0.0.1:9/v1",
        "apilens.send-heartbeat", "false",
        "apilens.send-metadata", "false"));
    try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
      context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
      context.register(Config.class);
      context.refresh();
      DataSource bean = context.getBean("dataSource", DataSource.class);
      assertTrue(AopUtils.isAopProxy(bean), "wrapped by the JDBC tracing proxy");
      try (Connection connection = bean.getConnection()) {
        connection.createStatement().execute("SELECT 1");
        DataSourcePools pools = poolsOf(context.getBean(ApiLensClient.class));
        List<Map<String, Object>> reported = pools(pools);
        Map<String, Object> pool = reported.stream().filter(p -> p.get("name").equals("dataSource")).findFirst().orElseThrow();
        assertEquals("hikari", pool.get("kind"));
        assertEquals(1L, ((Map<?, ?>) pool.get("used")).get("last"), "one connection checked out");
        assertEquals(4L, pool.get("max"));
        assertEquals(0L, ((Map<?, ?>) pool.get("pending")).get("max"));
        assertTrue(pool.containsKey("idle"));
      }
      // The delegating bean (not started yet) is retried and shows up once its pool starts.
      DataSourcePools pools = poolsOf(context.getBean(ApiLensClient.class));
      assertTrue(pools(pools).stream().noneMatch(p -> p.get("name").equals("reportingDataSource")));
      context.getBean("reportingDataSource", DataSource.class).getConnection().close();
      assertTrue(pools(pools).stream().anyMatch(p -> p.get("name").equals("reportingDataSource")));
    }
  }

  @Test
  void proxiesUnwrapToTheHikariPool() throws Exception {
    try (HikariDataSource target = hikari("unwrap")) {
      target.getConnection().close();
      DataSourcePools pools = new DataSourcePools();
      pools.register("delegating", new DelegatingDataSource(target));
      ApiLensClient client = new ApiLensClient(ai.apilens.ApiLensConfig.builder()
          .apiKey("k").baseUrl("http://127.0.0.1:9/v1").sendHeartbeat(false).sendMetadata(false).build());
      try {
        pools.register("traced", ApiLensDataSource.wrap(target, new ApiLensJdbcTracing(client, "production", "svc", true)));
        pools.register("traced-in-delegating", new DelegatingDataSource(
            (DataSource) ApiLensJdbcAutoConfiguration.wrap(target, new ApiLensJdbcTracing(client, "production", "svc", true))));
        List<Map<String, Object>> reported = pools(pools);
        assertEquals(List.of("delegating", "traced", "traced-in-delegating"),
            reported.stream().map(p -> p.get("name")).toList());
      } finally {
        client.shutdown(false);
      }
    }
  }

  @Test
  void aPoolThatHasNotStartedIsAbsentThenPresent() throws Exception {
    try (HikariDataSource lazy = hikari("lazy")) {
      DataSourcePools pools = new DataSourcePools();
      pools.register("lazy", lazy);
      ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(pools));
      sampler.sampleNow();
      Map<String, Object> before = sampler.drain();
      assertNull(before.get("pools"), "not started: absent, never zeros");
      assertTrue(((List<?>) before.get("capabilities")).isEmpty());
      lazy.getConnection().close();
      sampler.sampleNow();
      Map<String, Object> after = sampler.drain();
      assertEquals(1, ((List<?>) after.get("pools")).size());
      assertEquals(List.of("pools"), after.get("capabilities"));
    }
  }

  @Test
  void aNonHikariDataSourceIsIgnored() throws Exception {
    DataSourcePools pools = new DataSourcePools();
    pools.register("h2", new org.h2.jdbcx.JdbcDataSource());
    ResourceSampler sampler = new ResourceSampler(Duration.ofSeconds(15), List.of(pools));
    sampler.sampleNow();
    assertNull(sampler.drain().get("pools"));
    assertTrue(sampler.collectorErrors().get("pools") == 0L);
  }

  /** The client's pool registry (what the auto-configuration filled), read reflectively. */
  private static DataSourcePools poolsOf(ApiLensClient client) throws Exception {
    var field = ApiLensClient.class.getDeclaredField("dataSourcePools");
    field.setAccessible(true);
    return (DataSourcePools) field.get(client);
  }

  @ImportAutoConfiguration({
      ApiLensAutoConfiguration.class, ApiLensJdbcAutoConfiguration.class, ApiLensResourcesAutoConfiguration.class})
  static class Config {
    @Bean(destroyMethod = "close")
    HikariDataSource dataSource() {
      return hikari("dataSource");
    }

    @Bean
    DataSource reportingDataSource() {
      return new DelegatingDataSource(hikari("reporting"));
    }
  }
}
