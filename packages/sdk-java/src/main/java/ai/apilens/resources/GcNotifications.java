package ai.apilens.resources;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryUsage;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.management.ListenerNotFoundException;
import javax.management.Notification;
import javax.management.NotificationEmitter;
import javax.management.NotificationListener;
import javax.management.openmbean.CompositeData;

/**
 * Listens for {@code com.sun.management.GarbageCollectionNotificationInfo} on every collector
 * bean. The notification class is only touched after {@link #install} found it, so runtimes
 * without {@code com.sun.management} fall back to polling. Adding a listener registers nothing
 * in the platform MBean server.
 */
final class GcNotifications implements NotificationListener {
  static final String NOTIFICATION_CLASS = "com.sun.management.GarbageCollectionNotificationInfo";

  private final GcTracker tracker;
  private final List<NotificationEmitter> emitters = new ArrayList<>();

  private GcNotifications(GcTracker tracker) {
    this.tracker = tracker;
  }

  /** Listening notifications, or {@code null} when the runtime has none. */
  static GcNotifications install(GcTracker tracker) {
    try {
      Class.forName(NOTIFICATION_CLASS, false, GcNotifications.class.getClassLoader());
    } catch (ClassNotFoundException | LinkageError ex) {
      return null;
    }
    GcNotifications listener = new GcNotifications(tracker);
    try {
      for (GarbageCollectorMXBean bean : ManagementFactory.getGarbageCollectorMXBeans()) {
        if (bean instanceof NotificationEmitter emitter) {
          emitter.addNotificationListener(listener, null, null);
          listener.emitters.add(emitter);
        }
      }
    } catch (RuntimeException | LinkageError ex) {
      listener.remove();
      return null;
    }
    if (listener.emitters.isEmpty()) {
      return null;
    }
    return listener;
  }

  @Override
  public void handleNotification(Notification notification, Object handback) {
    try {
      if (!com.sun.management.GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION
          .equals(notification.getType()) || !(notification.getUserData() instanceof CompositeData data)) {
        return;
      }
      var info = com.sun.management.GarbageCollectionNotificationInfo.from(data);
      var gc = info.getGcInfo();
      Map<String, Long> after = new LinkedHashMap<>();
      if (gc != null && gc.getMemoryUsageAfterGc() != null) {
        for (Map.Entry<String, MemoryUsage> pool : gc.getMemoryUsageAfterGc().entrySet()) {
          if (pool.getValue() != null) {
            after.put(pool.getKey(), pool.getValue().getUsed());
          }
        }
      }
      tracker.onGc(info.getGcName(), info.getGcAction(), gc == null ? -1 : gc.getDuration(), after);
    } catch (RuntimeException | LinkageError ex) {
      // A malformed notification is skipped; GC accounting must never throw into the JVM.
    }
  }

  void remove() {
    for (NotificationEmitter emitter : emitters) {
      try {
        emitter.removeNotificationListener(this);
      } catch (ListenerNotFoundException | RuntimeException ex) {
        // Already gone.
      }
    }
    emitters.clear();
  }
}
