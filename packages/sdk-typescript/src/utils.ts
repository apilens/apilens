function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const num = Math.floor(toNumber(value, fallback));
  return num >= 0 ? num : fallback;
}

function normalizePath(path: unknown): string {
  const raw = String(path || "/").trim();
  if (!raw) {
    return "/";
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function toISO8601(value: unknown): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const asDate = new Date(value as string | number);
  if (Number.isNaN(asDate.getTime())) {
    return new Date().toISOString();
  }

  return asDate.toISOString();
}

function truncateUtf8(value: unknown, maxBytes: number): Buffer {
  if (maxBytes <= 0) {
    return Buffer.alloc(0);
  }

  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value || ""), "utf8");

  if (bytes.length <= maxBytes) {
    return bytes;
  }

  return bytes.subarray(0, maxBytes);
}

function payloadToString(value: unknown, maxBytes: number): string {
  if (maxBytes <= 0 || value == null) {
    return "";
  }

  if (Buffer.isBuffer(value)) {
    return truncateUtf8(value, maxBytes).toString("utf8");
  }

  if (typeof value === "string") {
    return truncateUtf8(value, maxBytes).toString("utf8");
  }

  try {
    return truncateUtf8(JSON.stringify(value), maxBytes).toString("utf8");
  } catch (_error) {
    return truncateUtf8(String(value), maxBytes).toString("utf8");
  }
}

function firstForwardedIp(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw.split(",", 1)[0].trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export {
  firstForwardedIp,
  isNonEmptyString,
  normalizePath,
  payloadToString,
  sleep,
  toISO8601,
  toNonNegativeInt,
  toNumber,
};
