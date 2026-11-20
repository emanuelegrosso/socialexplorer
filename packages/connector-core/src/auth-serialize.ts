type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Binary-safe JSON encoding compatible with Baileys `BufferJSON` ({type:"Buffer", data:<base64>}). */
export function encodeAuthValue(value: unknown): Json {
  if (isBytes(value)) {
    return { type: "Buffer", data: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => encodeAuthValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, Json> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) {
        output[key] = encodeAuthValue(nested);
      }
    }
    return output;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  return value as Json;
}

export function decodeAuthValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeAuthValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["type"] === "Buffer" && Object.keys(record).length === 2) {
      const data = record["data"];
      if (typeof data === "string") {
        return Buffer.from(data, "base64");
      }
      if (Array.isArray(data)) {
        return Buffer.from(data as number[]);
      }
    }
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      output[key] = decodeAuthValue(nested);
    }
    return output;
  }
  return value;
}
