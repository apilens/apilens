package ai.apilens.resources;

import java.lang.reflect.Method;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;

/**
 * {@code pools}: HikariCP connection pools of registered {@code DataSource}s. Each is unwrapped
 * (Spring AOP proxies, Spring's {@code DelegatingDataSource}, JDBC {@code unwrap}, the SDK's own
 * tracing wrapper) to a {@code HikariDataSource}, whose {@code getHikariPoolMXBean()} works
 * without JMX registration. Before the pool starts that bean is null: the pool is absent from
 * the block and retried every sample. HikariCP is optional and only reached reflectively.
 */
public final class DataSourcePools implements Collector {
  public static final int MAX_POOLS = 10;
  static final String HIKARI = "com.zaxxer.hikari.HikariDataSource";
  static final String HIKARI_POOL_BEAN = "com.zaxxer.hikari.HikariPoolMXBean";
  private static final int MAX_UNWRAP_DEPTH = 8;

  private static final class Entry {
    final String name;
    final Object dataSource;
    /** The HikariDataSource once found; {@code NOT_HIKARI} when it is some other pool. */
    Object hikari;
    Gauge used = new Gauge();
    Gauge pending = new Gauge();
    Double idle;
    Double max;

    Entry(String name, Object dataSource) {
      this.name = name;
      this.dataSource = dataSource;
    }
  }

  private static final Object NOT_HIKARI = new Object();
  private final List<Entry> entries = new ArrayList<>();

  /** Adds {@code dataSource} as pool {@code name}; at most {@value #MAX_POOLS}, no duplicates. */
  public synchronized void register(String name, Object dataSource) {
    if (dataSource == null || entries.size() >= MAX_POOLS) {
      return;
    }
    for (Entry entry : entries) {
      if (entry.dataSource == dataSource || entry.name.equals(name)) {
        return;
      }
    }
    String clean = name == null || name.isBlank() ? "default" : name.trim();
    entries.add(new Entry(clean.length() > 64 ? clean.substring(0, 64) : clean, dataSource));
  }

  public synchronized int size() {
    return entries.size();
  }

  @Override
  public String name() {
    return "pools";
  }

  @Override
  public String capability() {
    return "pools";
  }

  @Override
  public synchronized boolean sample(Window window, long now) throws ReflectiveOperationException {
    boolean measured = false;
    for (Entry entry : entries) {
      if (entry.hikari == null) {
        Object hikari = unwrapHikari(entry.dataSource);
        entry.hikari = hikari == null ? NOT_HIKARI : hikari;
      }
      if (entry.hikari == NOT_HIKARI) {
        continue;
      }
      Class<?> type = hikariClass(entry.hikari);
      if (type == null) {
        continue;
      }
      Object pool = type.getMethod("getHikariPoolMXBean").invoke(entry.hikari);
      if (pool == null) {
        continue; // not started yet: try again next sample
      }
      Class<?> bean = Class.forName(HIKARI_POOL_BEAN, false, type.getClassLoader());
      entry.used.add(number(bean.getMethod("getActiveConnections").invoke(pool)));
      entry.pending.add(number(bean.getMethod("getThreadsAwaitingConnection").invoke(pool)));
      entry.idle = number(bean.getMethod("getIdleConnections").invoke(pool));
      entry.max = number(type.getMethod("getMaximumPoolSize").invoke(entry.hikari));
      measured = true;
    }
    return measured;
  }

  @Override
  public synchronized void drain(Window window) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Entry entry : entries) {
      Map<String, Object> used = entry.used.toWire();
      if (used == null) {
        continue;
      }
      Map<String, Object> item = new LinkedHashMap<>();
      item.put("name", entry.name);
      item.put("kind", "hikari");
      item.put("used", used);
      if (entry.idle != null && Double.isFinite(entry.idle)) {
        item.put("idle", Gauge.num(entry.idle));
      }
      if (entry.max != null && Double.isFinite(entry.max)) {
        item.put("max", Gauge.num(entry.max));
      }
      Map<String, Object> pending = entry.pending.toWire();
      if (pending != null) {
        item.put("pending", pending);
      }
      out.add(item);
      entry.used = new Gauge();
      entry.pending = new Gauge();
    }
    if (!out.isEmpty()) {
      window.value("pools", out);
    }
  }

  private static double number(Object value) {
    return value instanceof Number n ? n.doubleValue() : Double.NaN;
  }

  /** The {@code HikariDataSource} behind {@code dataSource}, or {@code null}. */
  static Object unwrapHikari(Object dataSource) {
    Object current = dataSource;
    for (int depth = 0; depth < MAX_UNWRAP_DEPTH && current != null; depth++) {
      Class<?> hikari = hikariClass(current);
      if (hikari != null && hikari.isInstance(current)) {
        return current;
      }
      Object next = springTarget(current);
      if (next == null && current instanceof DataSource ds && hikari != null) {
        try {
          if (ds.isWrapperFor(hikari)) {
            next = ds.unwrap(hikari);
          }
        } catch (SQLException | RuntimeException ex) {
          next = null;
        }
      }
      if (next == null || next == current) {
        return null;
      }
      current = next;
    }
    return null;
  }

  private static Class<?> hikariClass(Object of) {
    for (ClassLoader loader : new ClassLoader[] {
        of.getClass().getClassLoader(), Thread.currentThread().getContextClassLoader(),
        DataSourcePools.class.getClassLoader()}) {
      if (loader == null) {
        continue;
      }
      try {
        return Class.forName(HIKARI, false, loader);
      } catch (ClassNotFoundException | LinkageError ex) {
        // Try the next loader.
      }
    }
    return null;
  }

  /** The target of a Spring AOP proxy or {@code DelegatingDataSource}; else {@code null}. */
  private static Object springTarget(Object proxy) {
    try {
      if (implementsType(proxy.getClass(), "org.springframework.aop.framework.Advised")) {
        Object source = invoke(proxy, "org.springframework.aop.framework.Advised", "getTargetSource");
        return source == null ? null : invoke(source, "org.springframework.aop.TargetSource", "getTarget");
      }
      if (implementsType(proxy.getClass(), "org.springframework.jdbc.datasource.DelegatingDataSource")) {
        return invoke(proxy, "org.springframework.jdbc.datasource.DelegatingDataSource", "getTargetDataSource");
      }
    } catch (Exception | LinkageError ex) {
      return null;
    }
    return null;
  }

  private static Object invoke(Object target, String typeName, String method) throws Exception {
    Class<?> type = Class.forName(typeName, false, target.getClass().getClassLoader());
    Method m = type.getMethod(method);
    return m.invoke(target);
  }

  private static boolean implementsType(Class<?> type, String name) {
    for (Class<?> c = type; c != null; c = c.getSuperclass()) {
      if (c.getName().equals(name)) {
        return true;
      }
      for (Class<?> i : c.getInterfaces()) {
        if (implementsInterface(i, name)) {
          return true;
        }
      }
    }
    return false;
  }

  private static boolean implementsInterface(Class<?> type, String name) {
    if (type.getName().equals(name)) {
      return true;
    }
    for (Class<?> parent : type.getInterfaces()) {
      if (implementsInterface(parent, name)) {
        return true;
      }
    }
    return false;
  }
}
