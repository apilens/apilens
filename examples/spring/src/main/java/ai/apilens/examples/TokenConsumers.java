package ai.apilens.examples;

import ai.apilens.ApiLensConsumer;
import ai.apilens.spring.ApiLensConsumerResolver;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Consumer attribution, the way a real API does it: each caller is a user who
 * sends a personal access token as Authorization: Bearer <token>. The app looks
 * the token up and hands the SDK who called: the user (id, name) and, as the
 * group, the company the user belongs to. The token itself never reaches APILens:
 * the SDKs redact authorization by default. A missing or unknown token is an
 * anonymous caller. The same users exist in examples/fastapi, examples/express
 * and examples/spring.
 */
@Configuration
public class TokenConsumers {
  static final Map<String, ApiLensConsumer> USERS =
      Map.ofEntries(
          Map.entry("demo_tok_priya", ApiLensConsumer.of("usr_1f3a9c", "Priya Shah", "Acme Corp")),
          Map.entry("demo_tok_daniel", ApiLensConsumer.of("usr_2b7e41", "Daniel Okafor", "Acme Corp")),
          Map.entry("demo_tok_mei", ApiLensConsumer.of("usr_3c9d02", "Mei Lin", "Acme Corp")),
          Map.entry("demo_tok_lucas", ApiLensConsumer.of("usr_4a1f77", "Lucas Moreau", "Acme Corp")),
          Map.entry("demo_tok_sofia", ApiLensConsumer.of("usr_5e6b13", "Sofia Rossi", "Globex Logistics")),
          Map.entry("demo_tok_arjun", ApiLensConsumer.of("usr_6d2c58", "Arjun Mehta", "Globex Logistics")),
          Map.entry("demo_tok_hana", ApiLensConsumer.of("usr_7f8a90", "Hana Kim", "Globex Logistics")),
          Map.entry("demo_tok_omar", ApiLensConsumer.of("usr_8b3e26", "Omar Haddad", "Initech")),
          Map.entry("demo_tok_emma", ApiLensConsumer.of("usr_9c4f31", "Emma Schulz", "Initech")),
          Map.entry("demo_tok_kenji", ApiLensConsumer.of("usr_a15d84", "Kenji Watanabe", "Umbrella Health")),
          Map.entry("demo_tok_ana", ApiLensConsumer.of("usr_b26e95", "Ana Silva", "Umbrella Health")),
          Map.entry("demo_tok_noah", ApiLensConsumer.of("usr_c37fa6", "Noah Williams", "Umbrella Health")));

  @Bean
  ApiLensConsumerResolver tokenConsumerResolver() {
    return (request, response) -> {
      String auth = request.getHeader("Authorization");
      if (auth == null || !auth.regionMatches(true, 0, "Bearer ", 0, 7)) {
        return ApiLensConsumer.empty();
      }
      return USERS.getOrDefault(auth.substring(7).trim(), ApiLensConsumer.empty());
    };
  }
}
