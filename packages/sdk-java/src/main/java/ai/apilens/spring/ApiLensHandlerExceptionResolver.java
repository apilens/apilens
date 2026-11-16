package ai.apilens.spring;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.web.servlet.HandlerExceptionResolver;
import org.springframework.web.servlet.ModelAndView;

/**
 * Records every handler exception on the request for {@link ApiLensSpringFilter}, then lets
 * Spring MVC resolve it as usual. Ordered first and always returns {@code null}, so it never
 * changes how the exception is handled: an {@code @ExceptionHandler} or {@code
 * @ControllerAdvice} still renders the response, and the filter still ships the exception with
 * its stack (ERROR when the response is 5xx, WARN below).
 */
public class ApiLensHandlerExceptionResolver implements HandlerExceptionResolver, Ordered {
  @Override
  public ModelAndView resolveException(
      HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
    if (ex != null) {
      request.setAttribute(ApiLensSpringFilter.EXCEPTION_ATTRIBUTE, ex);
    }
    return null;
  }

  @Override
  public int getOrder() {
    return Ordered.HIGHEST_PRECEDENCE;
  }
}
