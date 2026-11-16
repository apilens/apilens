package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.SpanRecord;
import ai.apilens.TraceContext;
import ai.apilens.jdbc.ApiLensDataSource;
import ai.apilens.jdbc.ApiLensJdbcTracing;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.aop.support.AopUtils;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.MapPropertySource;

class JdbcSpringTest {
  @Test
  void dataSourceBeansAreTracedAndKeepTheirType() throws Exception {
    try (AnnotationConfigApplicationContext context = context(Map.of())) {
      DataSource dataSource = context.getBean(DataSource.class);
      // A subclass proxy: still injectable as the concrete pool type.
      assertInstanceOf(PoolDataSource.class, dataSource);
      assertInstanceOf(PoolDataSource.class, context.getBean(PoolDataSource.class));
      assertTrue(AopUtils.isAopProxy(dataSource));
      assertEquals(1, context.getBeansOfType(ApiLensJdbcTracing.class).size());

      TraceContext trace = TraceContext.begin("");
      try (TraceContext.Scope ignored = trace.makeCurrent();
          Connection connection = dataSource.getConnection();
          Statement statement = connection.createStatement()) {
        statement.executeQuery("SELECT 'secret@example.com'").close();
      }
      List<SpanRecord> spans = new ArrayList<>();
      trace.releaseChildSpans(true, spans::add);
      assertEquals(1, spans.size());
      Map<String, Object> wire = spans.get(0).toWire(context.getBean(ai.apilens.ApiLensClient.class).config());
      assertEquals("db", wire.get("kind"));
      assertEquals("SELECT ?", wire.get("name"));
      assertFalse(wire.toString().contains("secret@example.com"));
    }
  }

  @Test
  void finalDataSourceClassGetsAnInterfaceProxy() throws Exception {
    JdbcDataSource h2 = new JdbcDataSource();
    h2.setURL("jdbc:h2:mem:final" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
    try (AnnotationConfigApplicationContext context = context(Map.of())) {
      Object wrapped = ApiLensJdbcAutoConfiguration.wrap(h2, context.getBean(ApiLensJdbcTracing.class));
      assertTrue(ApiLensDataSource.isWrapped(wrapped));
      assertTrue(((DataSource) wrapped).isWrapperFor(JdbcDataSource.class));
    }
  }

  @Test
  void captureSpansOffLeavesDataSourcesAlone() {
    try (AnnotationConfigApplicationContext context = context(Map.of("apilens.capture-spans", "false"))) {
      assertFalse(AopUtils.isAopProxy(context.getBean(DataSource.class)));
    }
  }

  @Test
  void needsAClient() {
    try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
      context.register(Config.class);
      context.refresh();
      assertTrue(context.getBeansOfType(ApiLensJdbcTracing.class).isEmpty());
      assertFalse(AopUtils.isAopProxy(context.getBean(DataSource.class)));
    }
  }

  private static AnnotationConfigApplicationContext context(Map<String, Object> extra) {
    Map<String, Object> properties = new HashMap<>(Map.of(
        "apilens.api-key", "test-key",
        "apilens.app-id", "orders-api",
        "apilens.base-url", "http://127.0.0.1:9/v1",
        "apilens.send-heartbeat", "false",
        "apilens.send-metadata", "false"));
    properties.putAll(extra);
    AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
    context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", properties));
    context.register(Config.class);
    context.refresh();
    return context;
  }

  @ImportAutoConfiguration({ApiLensAutoConfiguration.class, ApiLensJdbcAutoConfiguration.class})
  static class Config {
    @Bean
    PoolDataSource dataSource() {
      return new PoolDataSource("jdbc:h2:mem:spring" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
    }
  }

  /** Stands in for a connection pool class such as HikariDataSource (not final). */
  public static class PoolDataSource implements DataSource {
    private final JdbcDataSource delegate = new JdbcDataSource();

    public PoolDataSource() {}

    PoolDataSource(String url) {
      delegate.setURL(url);
    }

    @Override
    public Connection getConnection() throws SQLException {
      return delegate.getConnection();
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
      return delegate.getConnection(username, password);
    }

    @Override
    public PrintWriter getLogWriter() {
      return null;
    }

    @Override
    public void setLogWriter(PrintWriter out) {}

    @Override
    public void setLoginTimeout(int seconds) {}

    @Override
    public int getLoginTimeout() {
      return 0;
    }

    @Override
    public Logger getParentLogger() {
      return Logger.getGlobal();
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
      if (iface.isInstance(this)) {
        return iface.cast(this);
      }
      return delegate.unwrap(iface);
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) throws SQLException {
      return iface.isInstance(this) || delegate.isWrapperFor(iface);
    }
  }
}
