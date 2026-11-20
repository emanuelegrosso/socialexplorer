export function stripUndefined<T extends object>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== undefined) {
      output[key] = nested;
    }
  }
  return output as T;
}

export function nn<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function bool(value: boolean | undefined): 0 | 1 | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

export function toBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value === 1;
}

export function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}
