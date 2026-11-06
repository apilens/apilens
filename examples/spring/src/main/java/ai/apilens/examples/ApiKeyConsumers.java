package ai.apilens.examples;

import ai.apilens.ApiLensConsumer;
import ai.apilens.spring.ApiLensConsumerResolver;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Consumer attribution, the way a real API does it: callers send an API key in {@code X-API-Key},
 * the app looks the key up, and the SDK records who called (id, name, group). The key value itself
 * never reaches APILens: the SDKs redact {@code x-api-key} by default. A missing or unknown key is
 * an anonymous caller. The same registry exists in examples/fastapi and examples/express.
 */
@Configuration
public class ApiKeyConsumers {
  static final Map<String, ApiLensConsumer> API_CLIENTS =
      Map.of(
          "demo_key_acme", ApiLensConsumer.of("acme-corp", "Acme Corp", "enterprise"),
          "demo_key_globex", ApiLensConsumer.of("globex", "Globex Logistics", "enterprise"),
          "demo_key_umbrella", ApiLensConsumer.of("umbrella-health", "Umbrella Health", "enterprise"),
          "demo_key_initech", ApiLensConsumer.of("initech", "Initech", "growth"),
          "demo_key_stark", ApiLensConsumer.of("stark-industries", "Stark Industries", "growth"),
          "demo_key_piedpiper", ApiLensConsumer.of("pied-piper", "Pied Piper", "startup"),
          "demo_key_hooli", ApiLensConsumer.of("hooli-mobile", "Hooli Mobile App", "internal"));

  @Bean
  ApiLensConsumerResolver apiKeyConsumerResolver() {
    return (request, response) -> {
      String key = request.getHeader("X-API-Key");
      return key == null ? ApiLensConsumer.empty() : API_CLIENTS.getOrDefault(key.trim(), ApiLensConsumer.empty());
    };
  }
}
