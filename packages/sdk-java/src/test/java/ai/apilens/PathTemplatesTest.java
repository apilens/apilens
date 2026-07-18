package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PathTemplatesTest {
  @Test
  void usesFrameworkTemplateWhenPresent() {
    assertEquals(
        "/orders/{orderId}",
        PathTemplates.resolveEndpointPath("/orders/{orderId}", "/orders/123", true));
  }

  @Test
  void parametrizesIdLookingSegments() {
    assertEquals("/orders/{id}", PathTemplates.parametrizePath("/orders/123"));
    assertEquals("/users/{uuid}", PathTemplates.parametrizePath("/users/550e8400-e29b-41d4-a716-446655440000"));
    assertEquals("/files/{hash}", PathTemplates.parametrizePath("/files/0123456789abcdef01234567"));
  }

  @Test
  void keepsStableWords() {
    assertEquals("/settings/openapi", PathTemplates.parametrizePath("/settings/openapi"));
  }
}
