// APILens example app: Express + the TypeScript SDK (apilens-js-sdk).
//
// Same endpoint set as examples/fastapi and examples/spring:
//
//   GET  /health          liveness (excluded from capture by the SDK defaults)
//   GET  /orders/:id      JSON response, templated path
//   POST /orders          JSON body; 201, or 422 with validation errors
//   POST /login           application/x-www-form-urlencoded body
//   POST /upload          multipart/form-data (file + description)
//   GET  /boom            unhandled error -> 500
//   GET  /outbound        outbound HTTP call to EXAMPLE_OUTBOUND_URL
//
// Configuration is environment only:
//
//   EXAMPLE_POSTURE   off | metadata | redacted | full (default full). `off`
//                     does not install the middleware (the benchmark
//                     baseline); the others are the SDK captureProfile presets.
//   APILENS_*         read by the SDK itself (APILENS_API_KEY, APILENS_APP_ID,
//                     APILENS_BASE_URL, APILENS_ENVIRONMENT, APILENS_SAMPLE_RATE,
//                     APILENS_REDACT_*, APILENS_EXCLUDE_*, ...).

import express from "express";
import multer from "multer";

const POSTURES = ["off", "metadata", "redacted", "full"];

const posture = (process.env.EXAMPLE_POSTURE || "full").trim().toLowerCase() || "full";
if (!POSTURES.includes(posture)) {
  console.error(`EXAMPLE_POSTURE must be one of ${POSTURES.join(", ")}, got ${posture}`);
  process.exit(1);
}
const outboundUrl = (process.env.EXAMPLE_OUTBOUND_URL || "").trim();
const port = Number(process.env.PORT || 3000);

const app = express();

// Consumer attribution, the way a real API does it: each caller is a user who
// sends a personal access token as `Authorization: Bearer <token>`. The app looks
// the token up and hands the SDK who called: the user (id, name) and, as the
// group, the company the user belongs to. The token itself never reaches APILens:
// the SDKs redact `authorization` by default. A missing or unknown token is an
// anonymous caller. The same users exist in examples/fastapi, examples/express
// and examples/spring.
const USERS = {
  demo_tok_priya: { id: "usr_1f3a9c", name: "Priya Shah", group: "Acme Corp" },
  demo_tok_daniel: { id: "usr_2b7e41", name: "Daniel Okafor", group: "Acme Corp" },
  demo_tok_mei: { id: "usr_3c9d02", name: "Mei Lin", group: "Acme Corp" },
  demo_tok_lucas: { id: "usr_4a1f77", name: "Lucas Moreau", group: "Acme Corp" },
  demo_tok_sofia: { id: "usr_5e6b13", name: "Sofia Rossi", group: "Globex Logistics" },
  demo_tok_arjun: { id: "usr_6d2c58", name: "Arjun Mehta", group: "Globex Logistics" },
  demo_tok_hana: { id: "usr_7f8a90", name: "Hana Kim", group: "Globex Logistics" },
  demo_tok_omar: { id: "usr_8b3e26", name: "Omar Haddad", group: "Initech" },
  demo_tok_emma: { id: "usr_9c4f31", name: "Emma Schulz", group: "Initech" },
  demo_tok_kenji: { id: "usr_a15d84", name: "Kenji Watanabe", group: "Umbrella Health" },
  demo_tok_ana: { id: "usr_b26e95", name: "Ana Silva", group: "Umbrella Health" },
  demo_tok_noah: { id: "usr_c37fa6", name: "Noah Williams", group: "Umbrella Health" },
};
const consumerFromToken = (req) => {
  const [scheme, token] = String(req.headers?.authorization ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" ? (USERS[(token ?? "").trim()] ?? null) : null;
};

if (posture !== "off") {
  const { useApiLens } = await import("apilens-js-sdk/express");
  // apiKey, appId, baseUrl, environment and every capture option come from
  // APILENS_* env vars; the posture picks the capture profile.
  useApiLens(app, { captureProfile: posture, getConsumer: consumerFromToken });
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/health", (_req, res) => {
  res.json({ status: "ok", posture });
});

app.get("/orders/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(422).json({ errors: [{ field: "id", message: "must be an integer" }] });
    return;
  }
  res.json({ id, item: "widget", quantity: 2, status: "shipped" });
});

app.post("/orders", (req, res) => {
  const body = req.body ?? {};
  const errors = [];
  if (typeof body.item !== "string" || body.item.length === 0) {
    errors.push({ field: "item", message: "must be a non-empty string" });
  }
  if (!Number.isInteger(body.quantity) || body.quantity <= 0) {
    errors.push({ field: "quantity", message: "must be a positive integer" });
  }
  if (errors.length > 0) {
    res.status(422).json({ errors });
    return;
  }
  res.status(201).json({ id: 1001, item: body.item, quantity: body.quantity, status: "created" });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res
      .status(422)
      .json({ errors: [{ field: "username", message: "username and password are required" }] });
    return;
  }
  res.json({ username, token: "example-session-token", password_length: password.length });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(422).json({ errors: [{ field: "file", message: "is required" }] });
    return;
  }
  res.json({
    filename: req.file.originalname,
    size: req.file.size,
    description: req.body?.description ?? "",
  });
});

app.get("/boom", () => {
  throw new Error("example failure: /boom always throws");
});

app.get("/outbound", async (_req, res) => {
  if (!outboundUrl) {
    res.status(503).json({ detail: "EXAMPLE_OUTBOUND_URL is not set" });
    return;
  }
  try {
    const resp = await fetch(outboundUrl, { signal: AbortSignal.timeout(5000) });
    res.json({ url: outboundUrl, status: resp.status });
  } catch (err) {
    res.status(502).json({ detail: `outbound call failed: ${err.message}` });
  }
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`express example listening on :${port} (posture ${posture})`);
});

const shutdown = async () => {
  server.close();
  await app.apilensClient?.handleShutdown({ flush: true });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
