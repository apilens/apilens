export { ApiLensClient, DROP_REASONS } from "./client.js";
export {
  CAPTURE_EVERYTHING,
  applyRemotePolicy,
  narrowPayloadBytes,
  parseRemotePolicy,
} from "./policy.js";
export type { RemotePolicy } from "./policy.js";
export { MAX_METADATA_ROUTES, listExpressRoutes } from "./metadata.js";
export type { AppRoute } from "./metadata.js";
export {
  createApiLensMiddleware,
  createExpressMiddleware,
  instrumentExpress,
  setConsumer,
  trackConsumer,
  useApiLens,
} from "./express.js";
export {
  CAPTURE_PROFILE_NAMES,
  CAPTURE_PROFILES,
  ENV_OPTIONS,
  ENV_PREFIX,
  REDACTED_PROFILE_MAX_PAYLOAD_BYTES,
  applyCaptureProfile,
  envVar,
  loadEnvConfig,
  resolveConfig,
} from "./env.js";
export type { Env, EnvConfig } from "./env.js";
export {
  DEFAULT_EXCLUDED_PATHS,
  DEFAULT_EXCLUDED_USER_AGENTS,
  ENV_EXCLUDE_PATHS,
  RequestExcluder,
  splitPatterns,
} from "./exclusions.js";
export type { ExclusionOptions, ExclusionPatterns } from "./exclusions.js";
export {
  ENV_PARAMETRIZE_PATHS,
  expressPathToTemplate,
  expressRouteTemplate,
  parametrizeEnabled,
  parametrizePath,
  resolveEndpointPath,
} from "./routes.js";
export { Sampler, validateSampleRate } from "./sampling.js";
export type {
  SampleDecision,
  SampleOnRequest,
  SampleOnResponse,
  SampleRequestInfo,
  SampleResponseInfo,
  SamplerOptions,
} from "./sampling.js";
export {
  ContentTypeFilter,
  DEFAULT_CAPTURE_CONTENT_TYPES,
  DEFAULT_MASK_BODY_FIELDS,
  DEFAULT_MASK_HEADER_PATTERNS,
  DEFAULT_MASK_QUERY_PARAMS,
  FORM_CONTENT_TYPE,
  MASKED,
  MAX_BODY_DEPTH,
  MAX_HEADER_BYTES,
  REDACTED,
  Redactor,
  SENSITIVE_HEADERS,
  captureBody,
  maskBody,
  omittedBody,
  serializeHeaders,
} from "./sanitize.js";
export type {
  BodyMasker,
  HeaderMap,
  HeaderValue,
  RedactorOptions,
  RedactPattern,
  RequestBodyInfo,
  RequestBodyMasker,
  ResponseBodyInfo,
  ResponseBodyMasker,
  SerializeHeadersOptions,
} from "./sanitize.js";
export type {
  ApiLensClientConfig,
  ApiLensClientStats,
  ApiLensConsumer,
  ApiLensDropReason,
  ApiLensExpressConfig,
  ApiLensRecord,
  ApiLensRecordInput,
  CaptureProfile,
  Logger,
  RequestLoggingConfig,
} from "./types.js";
