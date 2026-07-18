package ai.apilens;

import ai.apilens.internal.Strings;
import java.util.Map;

/** Explicit caller identity attached to a captured request. */
public final class ApiLensConsumer {
  private static final ApiLensConsumer EMPTY = new ApiLensConsumer("", "", "");

  private final String id;
  private final String name;
  private final String group;

  private ApiLensConsumer(String id, String name, String group) {
    this.id = Strings.clean(id);
    this.name = Strings.clean(name);
    this.group = Strings.clean(group);
  }

  public static ApiLensConsumer empty() {
    return EMPTY;
  }

  public static ApiLensConsumer of(String id) {
    return new ApiLensConsumer(id, "", "");
  }

  public static ApiLensConsumer of(String id, String name, String group) {
    return new ApiLensConsumer(id, name, group);
  }

  public static ApiLensConsumer fromMap(Map<String, ?> value) {
    if (value == null) {
      return empty();
    }
    Object id = first(value, "id", "identifier", "consumer_id");
    Object name = first(value, "name", "username", "consumer_name");
    Object group = first(value, "group", "consumer_group");
    return of(string(id), string(name), string(group));
  }

  public boolean isEmpty() {
    return id.isEmpty();
  }

  public String id() {
    return id;
  }

  public String name() {
    return name;
  }

  public String group() {
    return group;
  }

  private static Object first(Map<String, ?> value, String... names) {
    for (String name : names) {
      Object current = value.get(name);
      if (current != null) {
        return current;
      }
    }
    return "";
  }

  private static String string(Object value) {
    return value == null ? "" : String.valueOf(value);
  }
}
