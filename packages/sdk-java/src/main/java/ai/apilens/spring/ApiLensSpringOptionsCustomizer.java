package ai.apilens.spring;

/**
 * Customizes the filter options built from {@code apilens.*} properties, for settings that
 * properties cannot express, such as the {@code maskRequestBody} / {@code maskResponseBody}
 * callbacks. Every customizer bean is applied, in {@code @Order}, by the auto-configuration.
 *
 * <pre>{@code
 * @Bean
 * ApiLensSpringOptionsCustomizer apiLensBodyMasking() {
 *   return options -> options.maskRequestBody((info, body) -> body);
 * }
 * }</pre>
 */
@FunctionalInterface
public interface ApiLensSpringOptionsCustomizer {
  void customize(ApiLensSpringOptions.Builder options);
}
