export function trimOrNull(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function isActive(fecbaj: unknown): boolean {
  return fecbaj == null || String(fecbaj).trim() === "";
}

export function formatDate(value: unknown): string | null {
  if (value == null) return null;

  let d: Date;

  if (typeof value === "number") {
    d = new Date(value * 86_400_000);
  } else {
    d = new Date(String(value));
  }

  if (isNaN(d.getTime())) return null;

  return d.toISOString().split("T")[0];
}
