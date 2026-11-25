/**
 * Registers the Node builtins with the runtime layer (`runtime.ts`). Imported
 * first by the Node-only entry points (root, Express, Fastify, NestJS, Koa)
 * so they work on every supported Node version, including those without
 * `process.getBuiltinModule`. The Hono entry point does not import it: it
 * finds the builtins by feature detection, or runs without them.
 * @internal
 */
import * as asyncHooks from "node:async_hooks";
import * as crypto from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import * as nodeModule from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as perfHooks from "node:perf_hooks";
import * as workerThreads from "node:worker_threads";
import * as zlib from "node:zlib";

import { registerBuiltin } from "./runtime.js";

registerBuiltin("async_hooks", asyncHooks);
registerBuiltin("crypto", crypto);
registerBuiltin("diagnostics_channel", diagnosticsChannel);
registerBuiltin("fs", fs);
registerBuiltin("http", http);
registerBuiltin("https", https);
registerBuiltin("module", nodeModule);
registerBuiltin("os", os);
registerBuiltin("path", path);
registerBuiltin("perf_hooks", perfHooks);
registerBuiltin("worker_threads", workerThreads);
registerBuiltin("zlib", zlib);
