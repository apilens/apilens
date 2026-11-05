export { ApiLensClient, DROP_REASONS } from "./client.js";
export {
  createApiLensMiddleware,
  createExpressMiddleware,
  instrumentExpress,
  setConsumer,
  trackConsumer,
  useApiLens,
} from "./express.js";
export {
  DEFAULT_EXCLUDED_PATHS,
  DEFAULT_EXCLUDED_USER_AGENTS,
  ENV_EXCLUDE_PATHS,
  RequestExcluder,
  splitPatterns,
} from "./exclusions.js";
export type { ExclusionOptions, ExclusionPatterns } from "./exclusions.js";
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
  DEFAULT_MASK_BODY_FIELDS,
  DEFAULT_MASK_HEADER_PATTERNS,
  DEFAULT_MASK_QUERY_PARAMS,
  MAX_BODY_DEPTH,
  MAX_HEADER_BYTES,
  REDACTED,
  Redactor,
  SENSITIVE_HEADERS,
  serializeHeaders,
} from "./sanitize.js";
export type {
  HeaderMap,
  HeaderValue,
  RedactorOptions,
  RedactPattern,
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
  Logger,
  RequestLoggingConfig,
} from "./types.js";
