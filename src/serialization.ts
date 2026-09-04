export type StoredValue =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "array"; value: StoredValue[] }
  | { type: "object"; value: Record<string, StoredValue> };

export function encodeStoredValue(value: unknown): StoredValue {
  return encode(value, new WeakSet<object>());
}

export function decodeStoredValue(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("Stored FlowForge value is malformed");
  }

  switch (value.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof value.value !== "boolean") throw new TypeError("Stored boolean is malformed");
      return value.value;
    case "number":
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
        throw new TypeError("Stored number is malformed");
      }
      return value.value;
    case "string":
      if (typeof value.value !== "string") throw new TypeError("Stored string is malformed");
      return value.value;
    case "array":
      if (!Array.isArray(value.value)) throw new TypeError("Stored array is malformed");
      return value.value.map((item) => decodeStoredValue(item));
    case "object": {
      if (!isRecord(value.value)) throw new TypeError("Stored object is malformed");
      const decoded: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.value)) decoded[key] = decodeStoredValue(item);
      return decoded;
    }
    default:
      throw new TypeError(`Unknown stored FlowForge value type "${value.type}"`);
  }
}

function encode(value: unknown, seen: WeakSet<object>): StoredValue {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };

  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("FlowForge durable state only supports finite numbers");
    }
    return { type: "number", value };
  }

  if (typeof value !== "object") {
    throw new TypeError(`FlowForge durable state cannot serialize values of type "${typeof value}"`);
  }

  if (seen.has(value)) throw new TypeError("FlowForge durable state cannot serialize circular values");
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return { type: "array", value: Array.from(value, (item) => encode(item, seen)) };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = value.constructor?.name ?? "custom object";
      throw new TypeError(`FlowForge durable state cannot serialize ${name}; use plain JSON-compatible objects`);
    }

    const encoded: Record<string, StoredValue> = {};
    for (const [key, item] of Object.entries(value)) encoded[key] = encode(item, seen);
    return { type: "object", value: encoded };
  } finally {
    seen.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
