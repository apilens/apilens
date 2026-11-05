/**
 * Runtime feature detection, so the capture core runs on Node and on edge
 * runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun) alike.
 *
 * The core never imports a `node:` module statically. Node builtins are
 * looked up at runtime: first the ones the Node adapters register (see
 * `node.ts`, imported by the root, Express, Fastify, NestJS and Koa entry
 * points), then `process.getBuiltinModule` where the runtime has it
 * (Node >= 20.16, Bun, Deno, Workers with `nodejs_compat`). Without them each
 * feature falls back to a Web-standard API (`crypto.getRandomValues`,
 * `CompressionStream`) or is skipped (outbound `http` spans).
 */

type BuiltinName =
  | "async_hooks"
  | "crypto"
  | "diagnostics_channel"
  | "http"
  | "https"
  | "module"
  | "path"
  | "zlib";

const registered = new Map<BuiltinName, unknown>();

type ProcessLike = {
  env?: Record<string, string | undefined>;
  versions?: Record<string, string | undefined>;
  pid?: number;
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
};

/** The global `process`, when the runtime has one. */
export function processObject(): ProcessLike | undefined {
  const proc = (globalThis as { process?: ProcessLike }).process;
  return proc && typeof proc === "object" ? proc : undefined;
}

/** The environment variables (`{}` on a runtime without `process.env`). */
export function processEnv(): Record<string, string | undefined> {
  return processObject()?.env ?? {};
}

/** Make a statically imported Node builtin available to the core. @internal */
export function registerBuiltin(name: BuiltinName, mod: unknown): void {
  if (mod) {
    registered.set(name, mod);
  }
}

/** A Node builtin module, or undefined when the runtime has none. */
export function builtin<T>(name: BuiltinName): T | undefined {
  const known = registered.get(name);
  if (known) {
    return known as T;
  }
  try {
    const mod = processObject()?.getBuiltinModule?.(`node:${name}`);
    if (mod) {
      registered.set(name, mod);
      return mod as T;
    }
  } catch {
    // Not available here.
  }
  return undefined;
}

/** The Node version ("" on a runtime that is not Node-compatible). */
export function nodeVersion(): string {
  return String(processObject()?.versions?.node || "");
}

type RuntimeGlobals = {
  Bun?: { version?: string };
  Deno?: { version?: { deno?: string } };
  EdgeRuntime?: unknown;
  navigator?: { userAgent?: string };
};

/** `name version` of the JavaScript runtime, for heartbeats. */
export function runtimeName(): string {
  const g = globalThis as RuntimeGlobals;
  if (g.Bun?.version) {
    return `bun ${g.Bun.version}`;
  }
  if (g.Deno?.version?.deno) {
    return `deno ${g.Deno.version.deno}`;
  }
  if (typeof g.EdgeRuntime === "string") {
    return "edge-light";
  }
  if (g.navigator?.userAgent === "Cloudflare-Workers") {
    return "workerd";
  }
  const node = nodeVersion();
  return node ? `node ${node}` : String(g.navigator?.userAgent || "unknown");
}

/**
 * Whether this looks like a request-scoped (serverless / edge) runtime,
 * where background timers do not run between requests: Cloudflare Workers,
 * Vercel / Next.js Edge, or anything without Node's `process`.
 */
export function isEdgeRuntime(): boolean {
  const g = globalThis as RuntimeGlobals;
  if (typeof g.EdgeRuntime === "string" || g.navigator?.userAgent === "Cloudflare-Workers") {
    return true;
  }
  return !nodeVersion();
}

type WebCrypto = {
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
  randomUUID?: () => string;
};

function webCrypto(): WebCrypto | undefined {
  const c = (globalThis as { crypto?: WebCrypto }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    return c;
  }
  const node = builtin<{ webcrypto?: WebCrypto }>("crypto");
  return node?.webcrypto && typeof node.webcrypto.getRandomValues === "function"
    ? node.webcrypto
    : undefined;
}

/** `n` random bytes (cryptographically strong when the runtime has Web Crypto). */
export function randomBytesArray(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = webCrypto();
  if (c?.getRandomValues) {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** `n` random bytes as 2n lower-case hex characters. */
export function randomHex(n: number): string {
  return toHex(randomBytesArray(n));
}

/** A random RFC 4122 version 4 UUID. */
export function randomUUID(): string {
  const c = webCrypto();
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  const b = randomBytesArray(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type ZlibLike = {
  gzip: (
    data: string,
    options: { level: number },
    cb: (error: Error | null, result: Uint8Array) => void,
  ) => void;
};

type CompressionStreamConstructor = new (format: "gzip") => TransformStream<Uint8Array, Uint8Array>;

/**
 * Gzip `text`: Node's zlib when present (its async API runs on the libuv
 * threadpool, off the request path), else the Web `CompressionStream`.
 * Rejects when the runtime has neither; the caller then sends identity.
 */
export async function gzipText(text: string, level: number): Promise<Uint8Array<ArrayBuffer>> {
  const zlib = builtin<ZlibLike>("zlib");
  if (zlib && typeof zlib.gzip === "function") {
    const compressed = await new Promise<Uint8Array>((resolve, reject) => {
      zlib.gzip(text, { level }, (error, result) => (error ? reject(error) : resolve(result)));
    });
    return new Uint8Array(compressed);
  }
  const Compression = (globalThis as { CompressionStream?: CompressionStreamConstructor })
    .CompressionStream;
  if (typeof Compression !== "function") {
    throw new Error("no gzip implementation in this runtime");
  }
  const stream = new Blob([text]).stream().pipeThrough(new Compression("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The async context store `trace.ts` keeps the request's trace in. */
export type ContextStore<T> = {
  run<R>(store: T, fn: () => R): R;
  exit<R>(fn: () => R): R;
  getStore(): T | undefined;
};

/**
 * Fallback without `AsyncLocalStorage`: the context is set only while `fn`
 * runs synchronously, so code after an `await` does not see it.
 */
export class SyncContextStore<T> implements ContextStore<T> {
  private current: T | undefined;

  run<R>(store: T, fn: () => R): R {
    const previous = this.current;
    this.current = store;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  exit<R>(fn: () => R): R {
    const previous = this.current;
    this.current = undefined;
    try {
      return fn();
    } finally {
      this.current = previous;
    }
  }

  getStore(): T | undefined {
    return this.current;
  }
}

type AlsConstructor = new <T>() => ContextStore<T>;

/** An `AsyncLocalStorage` when the runtime has one, else a synchronous store. */
export function createContextStore<T>(): ContextStore<T> {
  const Als =
    builtin<{ AsyncLocalStorage?: AlsConstructor }>("async_hooks")?.AsyncLocalStorage ??
    (globalThis as { AsyncLocalStorage?: AlsConstructor }).AsyncLocalStorage;
  if (typeof Als === "function") {
    try {
      return new Als<T>();
    } catch {
      // Fall through to the synchronous store.
    }
  }
  return new SyncContextStore<T>();
}
