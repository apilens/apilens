/**
 * Synchronous, never-throwing file reads for the resource collectors, under an
 * injectable root so tests point them at the fake trees in testdata/cgroup.
 *
 * The reads run only inside the sampler's timer, never on the request path.
 * `node:fs` is looked up at runtime (see runtime.ts): on a runtime without it
 * (edge) every read is null. A permission error (EACCES, Deno's
 * PermissionDenied) is null too, exactly like a missing file.
 */

import type * as nodeFs from "node:fs";

import { builtin } from "../runtime.js";

export type Reader = {
  /** The file's text, or null when it is missing or cannot be read. */
  text(path: string): string | null;
  /** Entry names of a directory, or null. */
  list(path: string): string[] | null;
  /** Whether `path` is a directory. */
  isDir(path: string): boolean;
};

function fsModule(): typeof nodeFs | undefined {
  return builtin<typeof nodeFs>("fs");
}

/** A reader rooted at `root` ("" = the real filesystem). */
export function fileReader(root = ""): Reader {
  const base = root.replace(/\/+$/, "");
  const at = (path: string): string => base + (path.startsWith("/") ? path : `/${path}`);
  return {
    text(path) {
      const fs = fsModule();
      if (!fs?.readFileSync) {
        return null;
      }
      try {
        return fs.readFileSync(at(path), "utf8");
      } catch {
        return null;
      }
    },
    list(path) {
      const fs = fsModule();
      if (!fs?.readdirSync) {
        return null;
      }
      try {
        return fs.readdirSync(at(path));
      } catch {
        return null;
      }
    },
    isDir(path) {
      const fs = fsModule();
      if (!fs?.statSync) {
        return false;
      }
      try {
        return fs.statSync(at(path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

/** `key value` lines (cpu.stat, memory.stat, memory.events) as a map. */
export function keyValues(text: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!text) {
    return out;
  }
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const n = Number(value);
    if (key && value !== undefined && Number.isFinite(n)) {
      out.set(key, n);
    }
  }
  return out;
}

/** `Key:   value kB` lines (/proc/<pid>/status, smaps_rollup), raw strings. */
export function colonFields(text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) {
    return out;
  }
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  }
  return out;
}

/** A `NNN kB` field in bytes, or undefined. */
export function kbField(fields: Map<string, string>, key: string): number | undefined {
  const raw = fields.get(key);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw.split(/\s+/)[0]);
  return Number.isFinite(n) ? n * 1024 : undefined;
}

/** One number in a file ("max" and anything unparseable: undefined). */
export function numberIn(text: string | null): number | undefined {
  if (text === null) {
    return undefined;
  }
  const raw = text.trim();
  if (raw === "" || raw === "max") {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
