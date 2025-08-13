/* eslint-disable no-instanceof/no-instanceof, no-plusplus */

/**
 * Normalizes SQL for D1 execution by removing extra whitespace and newlines
 * D1's exec() and prepare() methods have issues with multiline SQL statements
 * This function converts multiline template literals to single-line SQL
 */
export function normalizeSQL(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')  // Replace multiple whitespace/newlines with single space
    .trim();               // Remove leading/trailing whitespace
}

export function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v) && v.every(n => typeof n === 'number' && n >= 0 && n <= 255)) {
    return new Uint8Array(v as number[]);
  }
  if (typeof v === 'string') {
    // maybe base64
    try {
      const bin = atob(v);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch { /* fall through */ }
  }
  throw new Error(`Unsupported BLOB shape: ${Object.prototype.toString.call(v)}`);
}
