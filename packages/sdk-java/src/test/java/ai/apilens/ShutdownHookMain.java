package ai.apilens;

import java.time.Duration;

/**
 * Child-JVM program for {@link LosslessDeliveryTest#nonSpringClientFlushesOnJvmExit}: a plain
 * (non-Spring) client queues records and {@code main} returns without closing it. Only the
 * client's JVM shutdown hook can deliver them.
 */
public final class ShutdownHookMain {
  private ShutdownHookMain() {}

  public static void main(String[] args) {
    ApiLensClient client = new ApiLensClient(ApiLensConfig.builder()
        .apiKey("test")
        .appId("orders-api")
        .baseUrl(args[0] + "/v1")
        .sendHeartbeat(false)
        .sendMetadata(false)
        .flushInterval(Duration.ofHours(1))
        .build());
    for (int i = 0; i < 3; i += 1) {
      client.capture(RequestRecord.builder()
          .method("GET").path("/exit/" + i).statusCode(200).responseTimeMs(1).build());
    }
    System.out.println("queued " + client.stats().queuedRecords());
  }
}
