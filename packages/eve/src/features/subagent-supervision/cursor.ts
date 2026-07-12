export function initialCursor(): string {
  return encodeCursor(0);
}

export function encodeCursor(value: number): string {
  return `cursor:v1:${normalizeCursor(value).toString(36)}`;
}

export function decodeCursor(value: string): number {
  const match = /^cursor:v1:([0-9a-z]+)$/.exec(value);
  if (match === null) throw new Error("Invalid child cursor");
  const parsed = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid child cursor");
  return parsed;
}

export function normalizeCursor(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("cursor must be a non-negative number");
  return Math.floor(value);
}
