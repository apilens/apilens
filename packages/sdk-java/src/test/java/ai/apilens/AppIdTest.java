package ai.apilens;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

/** Optional {@code appId}: code &gt; APILENS_APP_ID &gt; OTEL_SERVICE_NAME &gt; omitted. */
class AppIdTest {
  private static final String NONE =
      "APILens: no app name configured; data goes to the project's default app"
          + " (set app_id, APILENS_APP_ID or OTEL_SERVICE_NAME)";

  private static ApiLensConfig config(Map<String, String> env, String explicit) {
    ApiLensConfig.Builder builder = ApiLensConfig.builderFromEnv(env).apiKey("k");
    if (explicit != null) {
      builder.appId(explicit);
    }
    return builder.build();
  }

  @Test
  void explicitWinsOverBothEnvVars() {
    ApiLensConfig config =
        config(Map.of("APILENS_APP_ID", "env-app", "OTEL_SERVICE_NAME", "otel"), "Orders API");
    assertEquals("Orders API", config.appId());
    assertEquals("appId", config.appIdSource());
    assertEquals("APILens: app \"Orders API\" (from appId)", config.describeAppChoice());
  }

  @Test
  void fallsBackToApilensAppIdThenOtelServiceName() {
    ApiLensConfig fromEnv =
        config(Map.of("APILENS_APP_ID", "orders-api", "OTEL_SERVICE_NAME", "otel"), null);
    assertEquals("orders-api", fromEnv.appId());
    assertEquals("APILens: app \"orders-api\" (from APILENS_APP_ID)", fromEnv.describeAppChoice());

    ApiLensConfig fromOtel = config(Map.of("APILENS_APP_ID", "  ", "OTEL_SERVICE_NAME", "otel"), "");
    assertEquals("otel", fromOtel.appId());
    assertEquals("OTEL_SERVICE_NAME", fromOtel.appIdSource());
  }

  @Test
  void omittedIsEmpty() {
    ApiLensConfig config = config(Map.of(), null);
    assertEquals("", config.appId());
    assertEquals("", config.appIdSource());
    assertEquals(NONE, config.describeAppChoice());
  }

  @Test
  void omittedClientStartsLogsAndSendsEmptyAppId() throws Exception {
    List<String> infos = new CopyOnWriteArrayList<>();
    Handler handler = new Handler() {
      @Override
      public void publish(LogRecord record) {
        if (record.getLevel() == Level.INFO) {
          infos.add(record.getMessage());
        }
      }

      @Override
      public void flush() {}

      @Override
      public void close() {}
    };
    Logger logger = Logger.getLogger("apilens");
    logger.addHandler(handler);
    try (ApiLensClientTest.IngestServer server = ApiLensClientTest.IngestServer.start()) {
      ApiLensClient client = new ApiLensClient(ApiLensConfig.builderFromEnv(Map.of())
          .apiKey("k")
          .baseUrl(server.url() + "/v1")
          .build());
      client.stop();
      assertTrue(infos.contains(NONE), infos.toString());
      assertFalse(client.reportMetadata("", Map::of));

      client.capture(RequestRecord.builder().method("GET").path("/orders").statusCode(200).build());
      assertEquals(1, client.flushAll());
      assertEquals(List.of("/v1/requests"), server.paths());
      assertTrue(server.bodies().get(0).contains("\"app_id\":\"\""), server.bodies().get(0));
      client.shutdown(false);
    } finally {
      logger.removeHandler(handler);
    }
  }
}
