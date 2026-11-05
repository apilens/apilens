export { ApiLensClient } from "./client.js";
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
export {
  DEFAULT_MASK_HEADER_PATTERNS,
  MAX_HEADER_BYTES,
  REDACTED,
  SENSITIVE_HEADERS,
  serializeHeaders,
} from "./sanitize.js";
export type { HeaderMap, HeaderValue, SerializeHeadersOptions } from "./sanitize.js";
export type {
  ApiLensClientConfig,
  ApiLensConsumer,
  ApiLensExpressConfig,
  ApiLensRecord,
  ApiLensRecordInput,
  Logger,
  RequestLoggingConfig,
} from "./types.js";
