import { describe, expect, it } from "vitest";
import { CONSUMER_SDKS, consumerDocsUrl, consumerSnippet, exploreIpHref, pickConsumerSdks, sdkForFramework } from "./consumer-setup";

describe("sdkForFramework", () => {
  it("maps what the SDKs report to a snippet tab", () => {
    expect(sdkForFramework("FastAPI")).toBe("python");
    expect(sdkForFramework("Flask")).toBe("python");
    expect(sdkForFramework("Django")).toBe("python");
    expect(sdkForFramework("Express")).toBe("express");
    expect(sdkForFramework("NestJS")).toBe("express");
    expect(sdkForFramework("Spring MVC")).toBe("spring");
    expect(sdkForFramework("Spring WebFlux")).toBe("spring");
    expect(sdkForFramework("")).toBeNull();
    expect(sdkForFramework("Rails")).toBeNull();
  });
});

describe("pickConsumerSdks", () => {
  it("keeps the SDKs the apps run, first reported first, once each", () => {
    expect(pickConsumerSdks(["Spring MVC", "FastAPI", "Flask", "Spring WebFlux"])).toEqual(["spring", "python"]);
  });

  it("shows every SDK when no app reported a known framework", () => {
    expect(pickConsumerSdks([])).toEqual(["python", "express", "spring"]);
    expect(pickConsumerSdks(["Rails", ""])).toEqual(CONSUMER_SDKS.map((t) => t.id));
  });
});

describe("consumerSnippet", () => {
  it("sets the consumer and its group with each SDK", () => {
    expect(consumerSnippet("python").code).toContain("set_consumer(request, identifier=user.id, name=user.name, group=user.plan)");
    expect(consumerSnippet("express").code).toContain("setConsumer(req, { id: req.user.id, name: req.user.email, group: req.user.plan })");
    expect(consumerSnippet("spring").code).toContain("ApiLensConsumers.setConsumer(user.getId(), user.getEmail(), user.getPlan())");
    expect(consumerSnippet("spring").title).toBe("Spring MVC: set the consumer");
  });
});

describe("consumerDocsUrl", () => {
  it("links each SDK's Identify consumers section", () => {
    expect(consumerDocsUrl("https://apilens.ai/docs/", "python")).toBe("https://apilens.ai/docs/setup-guides/fastapi#identify-consumers");
    expect(consumerDocsUrl("https://apilens.ai/docs", "express")).toBe("https://apilens.ai/docs/setup-guides/express#identify-consumers");
    expect(consumerDocsUrl("https://apilens.ai/docs", "spring")).toBe("https://apilens.ai/docs/setup-guides/spring-mvc#identify-consumers");
  });
});

describe("exploreIpHref", () => {
  it("opens Explore narrowed to the client IP, in the range", () => {
    const href = new URL(exploreIpHref("shop", "6h", "203.0.113.7"), "http://x");
    expect(href.pathname).toBe("/shop/explore");
    expect(href.searchParams.get("ip")).toBe("203.0.113.7");
    expect(href.searchParams.get("range")).toBe("6h");
  });
});
