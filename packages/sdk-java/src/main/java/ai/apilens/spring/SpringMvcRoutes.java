package ai.apilens.spring;

import ai.apilens.ApiLensClient;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.context.ApplicationContext;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * Lists the route templates of the Spring MVC {@code RequestMappingHandlerMapping} beans. Only
 * loaded when spring-webmvc is on the classpath (see {@link ApiLensMetadataReporter#routes}).
 */
final class SpringMvcRoutes {
  private SpringMvcRoutes() {}

  static List<Map<String, String>> list(ApplicationContext context) {
    List<Map<String, String>> out = new ArrayList<>();
    for (RequestMappingHandlerMapping mapping : context.getBeansOfType(RequestMappingHandlerMapping.class).values()) {
      for (RequestMappingInfo info : mapping.getHandlerMethods().keySet()) {
        Set<RequestMethod> methods = info.getMethodsCondition().getMethods();
        for (String path : info.getPatternValues()) {
          if (methods.isEmpty()) {
            out.add(route(ApiLensClient.ANY_METHOD, path));
          } else {
            methods.stream().map(Enum::name).sorted().forEach(method -> out.add(route(method, path)));
          }
        }
      }
    }
    out.sort((a, b) -> {
      int byPath = a.get("path").compareTo(b.get("path"));
      return byPath != 0 ? byPath : a.get("method").compareTo(b.get("method"));
    });
    return out;
  }

  private static Map<String, String> route(String method, String path) {
    Map<String, String> route = new LinkedHashMap<>();
    route.put("method", method);
    route.put("path", path);
    return route;
  }
}
