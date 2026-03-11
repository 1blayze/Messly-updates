export function nowIso(): string {
  return new Date().toISOString();
}

export function parseTimestampMs(value: string | number | Date | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const candidate = value.getTime();
    return Number.isFinite(candidate) ? candidate : null;
  }

  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareIsoTimestampsAsc(left: string | null | undefined, right: string | null | undefined): number {
  const leftMs = parseTimestampMs(left) ?? 0;
  const rightMs = parseTimestampMs(right) ?? 0;
  return leftMs - rightMs;
}

export function compareIsoTimestampsDesc(left: string | null | undefined, right: string | null | undefined): number {
  return compareIsoTimestampsAsc(right, left);
}
