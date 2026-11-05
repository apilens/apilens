package ai.apilens.examples;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.io.IOException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.multipart.MultipartFile;

/**
 * The shared example endpoint set.
 *
 * <pre>
 *   GET  /health          liveness (excluded from capture by the SDK defaults)
 *   GET  /orders/{id}     JSON response, templated path
 *   POST /orders          JSON body; 201, or 422 with validation errors
 *   POST /login           application/x-www-form-urlencoded body
 *   POST /upload          multipart/form-data (file + description)
 *   GET  /boom            unhandled exception -> 500
 *   GET  /outbound        outbound HTTP call to EXAMPLE_OUTBOUND_URL
 * </pre>
 */
@RestController
public class ExampleController {
  private final String outboundUrl;
  private final RestClient http;

  public ExampleController(@Value("${EXAMPLE_OUTBOUND_URL:}") String outboundUrl) {
    this.outboundUrl = outboundUrl.trim();
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(5));
    factory.setReadTimeout(Duration.ofSeconds(5));
    this.http = RestClient.builder().requestFactory(factory).build();
  }

  public record OrderIn(
      @NotBlank String item, @NotNull @Min(1) Integer quantity, String email,
      @JsonProperty("card_number") String cardNumber) {}

  @GetMapping("/health")
  public Map<String, Object> health() {
    return Map.of("status", "ok", "posture", ExampleApplication.posture());
  }

  @GetMapping("/orders/{id}")
  public Map<String, Object> getOrder(@PathVariable long id) {
    return order(id, "widget", 2, "shipped");
  }

  @PostMapping(value = "/orders", consumes = MediaType.APPLICATION_JSON_VALUE)
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> createOrder(@Valid @RequestBody OrderIn in) {
    return order(1001, in.item(), in.quantity(), "created");
  }

  @PostMapping(value = "/login", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
  public Map<String, Object> login(
      @RequestParam String username, @RequestParam String password) {
    return Map.of(
        "username", username,
        "token", "example-session-token",
        "password_length", password.length());
  }

  @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Map<String, Object> upload(
      @RequestParam("file") MultipartFile file,
      @RequestParam(value = "description", defaultValue = "") String description)
      throws IOException {
    return Map.of(
        "filename", String.valueOf(file.getOriginalFilename()),
        "size", file.getBytes().length,
        "description", description);
  }

  @GetMapping("/boom")
  public Map<String, Object> boom() {
    throw new IllegalStateException("example failure: /boom always throws");
  }

  @GetMapping("/outbound")
  public ResponseEntity<Map<String, Object>> outbound() {
    if (outboundUrl.isEmpty()) {
      return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
          .body(Map.of("detail", "EXAMPLE_OUTBOUND_URL is not set"));
    }
    try {
      int status =
          http.get()
              .uri(outboundUrl)
              .exchange((request, response) -> response.getStatusCode().value());
      return ResponseEntity.ok(Map.of("url", outboundUrl, "status", status));
    } catch (RestClientException e) {
      return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
          .body(Map.of("detail", "outbound call failed: " + e.getMessage()));
    }
  }

  /** Bean-validation failures answer 422 (Spring's default is 400), like the other examples. */
  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Map<String, Object>> invalid(MethodArgumentNotValidException e) {
    List<Map<String, String>> errors =
        e.getBindingResult().getFieldErrors().stream()
            .map(
                fe ->
                    Map.of(
                        "field",
                        fe.getField(),
                        "message",
                        String.valueOf(fe.getDefaultMessage())))
            .toList();
    return ResponseEntity.unprocessableEntity().body(Map.of("errors", errors));
  }

  private static Map<String, Object> order(long id, String item, int quantity, String status) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", id);
    out.put("item", item);
    out.put("quantity", quantity);
    out.put("status", status);
    return out;
  }
}
