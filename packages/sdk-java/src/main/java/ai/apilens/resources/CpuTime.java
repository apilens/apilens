package ai.apilens.resources;

import java.lang.management.ManagementFactory;
import java.lang.reflect.Method;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * The process's CPU time in nanoseconds, from the platform {@code OperatingSystemMXBean}: {@code
 * com.sun.management} on HotSpot (and current OpenJ9), {@code com.ibm.lang.management} on older
 * OpenJ9. Looked up reflectively through the public interface so a runtime without either
 * (GraalVM native image, a stripped JRE) simply has no process CPU (null), never an error.
 */
final class CpuTime {
  /** {interface, method returning nanoseconds}, in order of preference. */
  static final List<String[]> CANDIDATES = List.of(
      new String[] {"com.sun.management.OperatingSystemMXBean", "getProcessCpuTime"},
      new String[] {"com.ibm.lang.management.OperatingSystemMXBean", "getProcessCpuTimeByNS"});

  private CpuTime() {}

  /** The platform bean's CPU time, or {@code null} when this runtime has none. */
  static LongSupplier processCpuNanos() {
    try {
      return processCpuNanos(ManagementFactory.getOperatingSystemMXBean(), CANDIDATES);
    } catch (RuntimeException | LinkageError ex) {
      return null;
    }
  }

  /** {@code bean}'s CPU time through the first candidate interface it implements; else null. */
  static LongSupplier processCpuNanos(Object bean, List<String[]> candidates) {
    if (bean == null) {
      return null;
    }
    for (String[] candidate : candidates) {
      Class<?> type;
      try {
        type = Class.forName(candidate[0], false, CpuTime.class.getClassLoader());
      } catch (ClassNotFoundException | LinkageError | RuntimeException ex) {
        continue;
      }
      if (!type.isInstance(bean)) {
        continue;
      }
      Method method;
      try {
        method = type.getMethod(candidate[1]);
      } catch (NoSuchMethodException | RuntimeException ex) {
        continue;
      }
      LongSupplier supplier = () -> {
        try {
          Object value = method.invoke(bean);
          return value instanceof Number n ? n.longValue() : -1L;
        } catch (ReflectiveOperationException | RuntimeException ex) {
          return -1L;
        }
      };
      if (supplier.getAsLong() >= 0) {
        return supplier;
      }
    }
    return null;
  }
}
