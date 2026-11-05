package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertTrue;

import ai.apilens.spring.ApiLensProperties;
import ai.apilens.spring.ApiLensSpringOptions;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/** Keeps README.md's option tables in step with the code: every option is documented. */
class ReadmeTest {
  private static final Path README = Path.of("README.md");
  private static final Path MAIN_SOURCES = Path.of("src", "main", "java");
  private static final Pattern ENV_VARIABLE = Pattern.compile("\"(APILENS_[A-Z_]+)\"");

  @Test
  void documentsEverySpringProperty() throws IOException {
    String readme = Files.readString(README);
    List<String> missing = new ArrayList<>();
    for (Field field : ApiLensProperties.class.getDeclaredFields()) {
      if (Modifier.isStatic(field.getModifiers())) {
        continue;
      }
      String property = "apilens." + kebab(field.getName());
      if (!readme.contains("`" + property + "`")) {
        missing.add(property);
      }
    }
    assertTrue(missing.isEmpty(), "README.md does not document " + missing);
  }

  @Test
  void documentsEveryBuilderOption() throws IOException {
    String readme = Files.readString(README);
    List<String> missing = new ArrayList<>();
    for (Class<?> builder : List.of(ApiLensConfig.Builder.class, ApiLensSpringOptions.Builder.class)) {
      for (Method method : builder.getDeclaredMethods()) {
        if (!Modifier.isPublic(method.getModifiers()) || method.getReturnType() != builder) {
          continue;
        }
        if (!readme.contains("`" + method.getName() + "`")) {
          missing.add(builder.getEnclosingClass().getSimpleName() + "." + method.getName());
        }
      }
    }
    assertTrue(missing.isEmpty(), "README.md does not document " + missing);
  }

  @Test
  void documentsEveryEnvironmentVariable() throws IOException {
    String readme = Files.readString(README);
    Set<String> variables = new TreeSet<>();
    try (Stream<Path> sources = Files.walk(MAIN_SOURCES)) {
      for (Path source : sources.filter(path -> path.toString().endsWith(".java")).toList()) {
        Matcher matcher = ENV_VARIABLE.matcher(Files.readString(source));
        while (matcher.find()) {
          variables.add(matcher.group(1));
        }
      }
    }
    assertTrue(variables.contains("APILENS_API_KEY"), "no APILENS_* variables found in " + MAIN_SOURCES);
    List<String> missing = variables.stream()
        .filter(variable -> !readme.contains("`" + variable + "`"))
        .toList();
    assertTrue(missing.isEmpty(), "README.md does not document " + missing);
  }

  private static String kebab(String camel) {
    return camel.replaceAll("([a-z0-9])([A-Z])", "$1-$2").toLowerCase();
  }
}
