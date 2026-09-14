/**
 * Opaque keyset cursor for `(created_at, id)` pagination. The UI passes it back
 * untouched; only this module knows the encoding.
 */
export type Cursor = { createdAt: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString(
    "base64url"
  );
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) {
    return null;
  }
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt)) || id.length === 0) {
    return null;
  }
  return { createdAt, id };
}
