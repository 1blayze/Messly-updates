import { supabase } from "../../lib/supabaseClient";

type PresenceTableName = "user_presence" | "presence";
type PresenceColumnCapabilities = {
  hasActivitiesColumn: boolean;
};

const PRESENCE_TABLE_CANDIDATES: ReadonlyArray<PresenceTableName> = ["user_presence", "presence"];
const DEFAULT_PRESENCE_SELECT_WITH_ACTIVITIES = "user_id,status,activities,last_seen,updated_at";
const DEFAULT_PRESENCE_SELECT_WITHOUT_ACTIVITIES = "user_id,status,last_seen,updated_at";

let presenceTableName: PresenceTableName | null = null;
let inFlightResolvePresenceTable: Promise<PresenceTableName> | null = null;
const presenceColumnCapabilitiesByTable = new Map<PresenceTableName, PresenceColumnCapabilities>();
const inFlightPresenceColumnCapabilities = new Map<PresenceTableName, Promise<PresenceColumnCapabilities>>();

function toLower(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function isRelationMissingError(error: unknown): boolean {
  const details = toLower((error as { details?: unknown } | null)?.details);
  const message = toLower((error as { message?: unknown } | null)?.message);
  const hint = toLower((error as { hint?: unknown } | null)?.hint);
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const combined = `${status} ${code} ${message} ${details} ${hint}`;

  if (status === 404 || code === "42P01" || code === "PGRST116" || code === "PGRST205") {
    return true;
  }

  return (
    (combined.includes("relation") && combined.includes("does not exist")) ||
    (combined.includes("table") && combined.includes("not found")) ||
    (combined.includes("schema cache") && combined.includes("user_presence"))
  );
}

function tryResolvePresenceTableHint(error: unknown): PresenceTableName | null {
  const hint = toLower((error as { hint?: unknown } | null)?.hint);
  if (!hint) {
    return null;
  }

  if (hint.includes("public.presence")) {
    return "presence";
  }

  if (hint.includes("public.user_presence")) {
    return "user_presence";
  }

  return null;
}

function isActivitiesColumnMissingError(error: unknown): boolean {
  const details = toLower((error as { details?: unknown } | null)?.details);
  const message = toLower((error as { message?: unknown } | null)?.message);
  const hint = toLower((error as { hint?: unknown } | null)?.hint);
  const status = Number((error as { status?: unknown } | null)?.status ?? 0);
  const code = String((error as { code?: unknown } | null)?.code ?? "").trim().toUpperCase();
  const combined = `${status} ${code} ${message} ${details} ${hint}`;

  if (code === "42703" || code === "PGRST204") {
    return true;
  }

  return (
    (combined.includes("column") && combined.includes("activities") && combined.includes("does not exist")) ||
    (combined.includes("activities") && combined.includes("schema cache"))
  );
}

async function detectPresenceTableColumnCapabilities(candidate: PresenceTableName): Promise<PresenceColumnCapabilities> {
  const { error } = await supabase.from(candidate).select("activities", { head: true, count: "exact" }).limit(1);
  if (!error) {
    return { hasActivitiesColumn: true };
  }

  if (isActivitiesColumnMissingError(error)) {
    return { hasActivitiesColumn: false };
  }

  if (isRelationMissingError(error)) {
    throw error;
  }

  // Se não conseguimos validar de forma segura, mantenha comportamento conservador:
  // tenta sem a coluna para evitar quebra em ambientes com schema legado.
  return { hasActivitiesColumn: false };
}

export function resolvePresenceSelectColumns(hasActivitiesColumn: boolean): string {
  return hasActivitiesColumn ? DEFAULT_PRESENCE_SELECT_WITH_ACTIVITIES : DEFAULT_PRESENCE_SELECT_WITHOUT_ACTIVITIES;
}

async function detectPresenceTable(): Promise<PresenceTableName> {
  let relationMissingError: unknown = null;

  for (const candidate of PRESENCE_TABLE_CANDIDATES) {
    const { error } = await supabase.from(candidate).select("user_id", { head: true, count: "exact" }).limit(1);
    if (!error) {
      presenceTableName = candidate;
      return candidate;
    }

    if (isRelationMissingError(error)) {
      const hintedTable = tryResolvePresenceTableHint(error);
      if (hintedTable) {
        presenceTableName = hintedTable;
        return hintedTable;
      }
      relationMissingError = error;
      continue;
    }

    throw error;
  }

  if (presenceTableName) {
    return presenceTableName;
  }

  if (relationMissingError) {
    throw relationMissingError;
  }

  return "presence";
}

export function getPresenceTableNameSync(): PresenceTableName {
  return presenceTableName ?? "presence";
}

export async function getPresenceTableName(): Promise<PresenceTableName> {
  if (presenceTableName) {
    return presenceTableName;
  }

  if (inFlightResolvePresenceTable) {
    return inFlightResolvePresenceTable;
  }

  const promise = detectPresenceTable();
  inFlightResolvePresenceTable = promise;
  try {
    return await promise;
  } finally {
    if (inFlightResolvePresenceTable === promise) {
      inFlightResolvePresenceTable = null;
    }
  }
}

export async function getPresenceTableColumnCapabilities(): Promise<PresenceColumnCapabilities> {
  const tableName = await getPresenceTableName();

  const cached = presenceColumnCapabilitiesByTable.get(tableName);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightPresenceColumnCapabilities.get(tableName);
  if (inFlight) {
    return inFlight;
  }

  const promise = detectPresenceTableColumnCapabilities(tableName);
  inFlightPresenceColumnCapabilities.set(tableName, promise);
  try {
    const capabilities = await promise;
    presenceColumnCapabilitiesByTable.set(tableName, capabilities);
    return capabilities;
  } finally {
    const current = inFlightPresenceColumnCapabilities.get(tableName);
    if (current === promise) {
      inFlightPresenceColumnCapabilities.delete(tableName);
    }
  }
}

export function setPresenceTableNameOverride(name: PresenceTableName | null): void {
  presenceTableName = name;
  inFlightResolvePresenceTable = null;
  presenceColumnCapabilitiesByTable.clear();
  inFlightPresenceColumnCapabilities.clear();
}
