package ai.apilens.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.web.reactive.context.AnnotationConfigReactiveWebApplicationContext;
import org.springframework.core.env.MapPropertySource;
import org.springframework.web.reactive.config.EnableWebFlux;

/**
 * A reactive app usually has neither the servlet API nor spring-webmvc. Loads the SDK in a class
 * loader without them and checks the WebFlux auto-configuration still wires the client and the
 * filter (the servlet auto-configuration backs off instead of failing).
 */
class WebFluxOnlyClasspathTest {
  @Test
  void autoConfigurationWorksWithoutTheServletApi() throws Exception {
    List<URL> urls = new ArrayList<>();
    String classpath = System.getProperty("java.class.path", "");
    for (String entry : classpath.split(File.pathSeparator)) {
      String name = new File(entry).getName();
      if (entry.isBlank() || name.startsWith("jakarta.servlet-api") || name.startsWith("spring-webmvc")) {
        continue;
      }
      urls.add(new File(entry).toURI().toURL());
    }
    assumeTrue(urls.size() > 5, "test classpath not visible as java.class.path");

    ClassLoader previous = Thread.currentThread().getContextClassLoader();
    try (URLClassLoader isolated = new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader())) {
      Thread.currentThread().setContextClassLoader(isolated);
      Class<?> app = Class.forName(WebFluxOnlyApp.class.getName(), true, isolated);
      Object summary = app.getMethod("run").invoke(null);
      assertEquals("servlet=absent webFilter=1 reporter=1 client=1", summary);
    } finally {
      Thread.currentThread().setContextClassLoader(previous);
    }
  }

  /** Runs inside the isolated class loader. */
  public static final class WebFluxOnlyApp {
    private WebFluxOnlyApp() {}

    public static String run() throws Exception {
      String servlet;
      try {
        Class.forName("jakarta.servlet.Filter", false, WebFluxOnlyApp.class.getClassLoader());
        servlet = "present";
      } catch (ClassNotFoundException expected) {
        servlet = "absent";
      }
      try (AnnotationConfigReactiveWebApplicationContext context = new AnnotationConfigReactiveWebApplicationContext()) {
        context.setClassLoader(WebFluxOnlyApp.class.getClassLoader());
        context.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
            "apilens.api-key", "test-key",
            "apilens.app-id", "orders-api",
            "apilens.base-url", "http://127.0.0.1:9/v1",
            "apilens.send-heartbeat", "false",
            "apilens.send-metadata", "false")));
        context.register(Config.class);
        context.refresh();
        return "servlet=" + servlet
            + " webFilter=" + context.getBeansOfType(ApiLensWebFilter.class).size()
            + " reporter=" + context.getBeansOfType(ApiLensMetadataReporter.class).size()
            + " client=" + context.getBeansOfType(ai.apilens.ApiLensClient.class).size();
      }
    }

    // Imported by name, as Spring Boot does, so the servlet auto-configuration's conditions are
    // read without loading its classes.
    @EnableWebFlux
    @ImportAutoConfiguration({
        ApiLensWebFluxAutoConfiguration.class,
        ApiLensAutoConfiguration.class,
        ApiLensMetricsAutoConfiguration.class})
    static class Config {}
  }
}
