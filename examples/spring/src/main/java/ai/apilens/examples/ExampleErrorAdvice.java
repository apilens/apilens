package ai.apilens.examples;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;

/** Framework-handled failure: {@link HandledFailure} becomes a JSON 500 here, not in a filter. */
@ControllerAdvice
public class ExampleErrorAdvice {
  @ExceptionHandler(HandledFailure.class)
  public ResponseEntity<Map<String, Object>> handled(HandledFailure e) {
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(Map.of("detail", String.valueOf(e.getMessage())));
  }
}
