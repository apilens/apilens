package ai.apilens.jdbc;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import javax.sql.DataSource;

/**
 * {@code db} spans for JDBC: wraps a {@code DataSource} (or a single {@code Connection}) so that
 * every statement executed while a request is captured becomes a child span of the request
 * ({@link ApiLensJdbcTracing}). Spring Boot wraps every {@code DataSource} bean automatically; by
 * hand: {@code ApiLensDataSource.wrap(dataSource, ApiLensJdbcTracing.of(client))}.
 *
 * <p>Only the SQL text is read, never bound parameter values, and it is obfuscated before it is
 * recorded. {@code unwrap} and {@code isWrapperFor} reach the original objects.
 */
public final class ApiLensDataSource {
  private static final Set<String> EXECUTE_METHODS = Set.of(
      "execute", "executeQuery", "executeUpdate", "executeLargeUpdate", "executeBatch", "executeLargeBatch");

  private ApiLensDataSource() {}

  /** {@code dataSource} with its connections traced; returned as is when already wrapped. */
  public static DataSource wrap(DataSource dataSource, ApiLensJdbcTracing tracing) {
    if (dataSource == null || tracing == null || isWrapped(dataSource)) {
      return dataSource;
    }
    return proxy(DataSource.class, new DataSourceHandler(dataSource, tracing));
  }

  /** {@code connection} with its statements traced; returned as is when already wrapped. */
  public static Connection wrap(Connection connection, ApiLensJdbcTracing tracing) {
    if (connection == null || tracing == null || isWrapped(connection)) {
      return connection;
    }
    return proxy(Connection.class, new ConnectionHandler(connection, tracing, null));
  }

  /** Whether {@code value} is a DataSource or Connection wrapped by this class. */
  public static boolean isWrapped(Object value) {
    return value != null && Proxy.isProxyClass(value.getClass())
        && Proxy.getInvocationHandler(value) instanceof Handler;
  }

  /** The traced form of a connection a DataSource handed out. */
  private static Connection wrapConnection(Connection connection, ApiLensJdbcTracing tracing, String system) {
    if (connection == null || isWrapped(connection)) {
      return connection;
    }
    return proxy(Connection.class, new ConnectionHandler(connection, tracing, system));
  }

  @SuppressWarnings("unchecked")
  private static <T> T proxy(Class<T> type, Handler handler) {
    return (T) Proxy.newProxyInstance(ApiLensDataSource.class.getClassLoader(), new Class<?>[] {type}, handler);
  }

  private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
    try {
      return method.invoke(target, args);
    } catch (InvocationTargetException ex) {
      throw ex.getCause();
    }
  }

  /** {@code unwrap}/{@code isWrapperFor}/{@code equals}/{@code hashCode}; null when not one. */
  private static Object common(Object proxy, Object target, Method method, Object[] args) throws Throwable {
    switch (method.getName()) {
      case "unwrap":
        if (args != null && args.length == 1 && args[0] instanceof Class<?> type && type.isInstance(proxy)) {
          return proxy;
        }
        return null;
      case "isWrapperFor":
        if (args != null && args.length == 1 && args[0] instanceof Class<?> type && type.isInstance(proxy)) {
          return true;
        }
        return null;
      case "equals":
        return args != null && args.length == 1 && args[0] == proxy;
      case "hashCode":
        return System.identityHashCode(proxy);
      case "toString":
        return "ApiLens(" + target + ")";
      default:
        return null;
    }
  }

  private abstract static class Handler implements InvocationHandler {
    final Object target;

    Handler(Object target) {
      this.target = target;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
      if (method.getDeclaringClass() == Object.class || method.getName().equals("unwrap")
          || method.getName().equals("isWrapperFor")) {
        Object handled = common(proxy, target, method, args);
        if (handled != null) {
          return handled;
        }
      }
      return handle(proxy, method, args);
    }

    abstract Object handle(Object proxy, Method method, Object[] args) throws Throwable;
  }

  private static final class DataSourceHandler extends Handler {
    private final ApiLensJdbcTracing tracing;
    private volatile String system;

    DataSourceHandler(DataSource target, ApiLensJdbcTracing tracing) {
      super(target);
      this.tracing = tracing;
    }

    @Override
    Object handle(Object proxy, Method method, Object[] args) throws Throwable {
      Object result = ApiLensDataSource.invoke(target, method, args);
      if (method.getName().equals("getConnection") && result instanceof Connection connection) {
        if (!tracing.enabled()) {
          return connection;
        }
        if (system == null) {
          system = systemOf(connection);
        }
        return wrapConnection(connection, tracing, system);
      }
      return result;
    }
  }

  private static String systemOf(Connection connection) {
    try {
      return ApiLensJdbcTracing.systemFromUrl(connection.getMetaData().getURL());
    } catch (SQLException | RuntimeException ex) {
      return "other";
    }
  }

  private static final class ConnectionHandler extends Handler {
    private final ApiLensJdbcTracing tracing;
    private String system;

    ConnectionHandler(Connection target, ApiLensJdbcTracing tracing, String system) {
      super(target);
      this.tracing = tracing;
      this.system = system;
    }

    @Override
    Object handle(Object proxy, Method method, Object[] args) throws Throwable {
      Object result = ApiLensDataSource.invoke(target, method, args);
      String name = method.getName();
      Class<?> type;
      String sql;
      if (name.equals("createStatement") && result instanceof Statement) {
        type = Statement.class;
        sql = null;
      } else if (name.equals("prepareStatement") && result instanceof PreparedStatement) {
        type = PreparedStatement.class;
        sql = (String) args[0];
      } else if (name.equals("prepareCall") && result instanceof CallableStatement) {
        type = CallableStatement.class;
        sql = (String) args[0];
      } else {
        return result;
      }
      if (system == null) {
        system = systemOf((Connection) target);
      }
      return proxy(type, new StatementHandler(result, (Connection) proxy, tracing, system, sql));
    }
  }

  private static final class StatementHandler extends Handler {
    private final Connection connection;
    private final ApiLensJdbcTracing tracing;
    private final String system;
    private final String preparedSql;
    private final List<String> batch = new ArrayList<>();

    StatementHandler(Object target, Connection connection, ApiLensJdbcTracing tracing, String system,
        String preparedSql) {
      super(target);
      this.connection = connection;
      this.tracing = tracing;
      this.system = system;
      this.preparedSql = preparedSql;
    }

    @Override
    Object handle(Object proxy, Method method, Object[] args) throws Throwable {
      String name = method.getName();
      if (name.equals("getConnection") && (args == null || args.length == 0)) {
        return connection;
      }
      if (name.equals("addBatch") && args != null && args.length == 1 && args[0] instanceof String sql) {
        synchronized (batch) {
          batch.add(sql);
        }
      } else if (name.equals("clearBatch")) {
        synchronized (batch) {
          batch.clear();
        }
      }
      if (!EXECUTE_METHODS.contains(name)) {
        return ApiLensDataSource.invoke(target, method, args);
      }
      String sql;
      if (name.equals("executeBatch") || name.equals("executeLargeBatch")) {
        // A PreparedStatement batch runs its one statement; a Statement batch the added ones.
        synchronized (batch) {
          sql = preparedSql != null ? preparedSql : String.join("; ", batch);
          batch.clear();
        }
      } else {
        sql = args != null && args.length > 0 && args[0] instanceof String text ? text : preparedSql;
      }
      ApiLensJdbcTracing.DbSpan span = tracing.start(system, sql);
      if (span == null) {
        return ApiLensDataSource.invoke(target, method, args);
      }
      Object result;
      try {
        result = ApiLensDataSource.invoke(target, method, args);
      } catch (Throwable ex) {
        span.end(ex);
        throw ex;
      }
      span.end(null);
      return result;
    }
  }
}
