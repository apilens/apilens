/**
 * Contract helpers: the ingest edge's OpenAPI document
 * (api/openapi/apilens.v1.json, generated from internal/ingest by
 * `task gen:openapi`) and a small JSON Schema checker covering what that
 * document uses. The SDK's heartbeat and metadata bodies are checked against
 * the request schemas the Go handlers are documented with, and ingest's
 * documented responses are fed back into the SDK.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
};

type OpenAPI = {
  paths: Record<string, Record<string, {
    requestBody?: { content: Record<string, { schema: Schema }> };
    responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
  }>>;
  components: { schemas: Record<string, Schema> };
};

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../api/openapi/apilens.v1.json");

export const spec: OpenAPI = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

function resolve(schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const target = spec.components.schemas[name];
    if (!target) {
      throw new Error(`unknown schema ${schema.$ref}`);
    }
    return resolve(target);
  }
  return schema;
}

/** The JSON request schema of `POST path`. */
export function requestSchema(path: string): Schema {
  const op = spec.paths[path]?.post;
  if (!op?.requestBody) {
    throw new Error(`no POST ${path} in the OpenAPI document`);
  }
  return resolve(op.requestBody.content["application/json"].schema);
}

/** The JSON schema of the `status` response of `POST path`. */
export function responseSchema(path: string, status: string): Schema {
  const content = spec.paths[path]?.post?.responses[status]?.content;
  if (!content) {
    throw new Error(`no ${status} response for POST ${path}`);
  }
  return resolve(content["application/json"].schema);
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/** Every violation of `schema` by `value` (empty when it conforms). */
export function validate(value: unknown, schemaIn: Schema, at = "$"): string[] {
  const schema = resolve(schemaIn);
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      return [`${at}: expected ${types.join("|")}, got ${typeOf(value)}`];
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: longer than ${schema.maxLength}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: below ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: above ${schema.maximum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items as Schema, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${at}: missing required ${key}`);
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const prop = schema.properties?.[key];
      if (prop) {
        errors.push(...validate(child, prop, `${at}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property ${key}`);
      }
    }
  }
  return errors;
}

/** Mirror of the ingest edge's `hasAPIKeyField`: such a body answers 422. */
export function hasApiKeyField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasApiKeyField);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, child]) => key.toLowerCase().replace(/[_\-. ]/g, "") === "apikey" || hasApiKeyField(child),
    );
  }
  return false;
}
