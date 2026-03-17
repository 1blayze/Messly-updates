type SchemaCapabilityKey =
  | "conversations_extended_columns"
  | "conversation_members_table"
  | "create_group_dm_rpc";

const SCHEMA_CAPABILITY_STORAGE_PREFIX = "messly:schema-capability:v3:";
const schemaCapabilityCache = new Map<SchemaCapabilityKey, boolean | null>();
const DEFAULT_SCHEMA_CAPABILITIES: Record<SchemaCapabilityKey, boolean | null> = {
  conversations_extended_columns: null,
  conversation_members_table: null,
  create_group_dm_rpc: null,
};

function readCapabilityFromStorage(key: SchemaCapabilityKey): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = String(window.localStorage.getItem(`${SCHEMA_CAPABILITY_STORAGE_PREFIX}${key}`) ?? "").trim();
    if (raw === "1") {
      return true;
    }
    if (raw === "0") {
      return false;
    }
  } catch {
    // ignore storage read failures
  }

  return null;
}

function writeCapabilityToStorage(key: SchemaCapabilityKey, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(`${SCHEMA_CAPABILITY_STORAGE_PREFIX}${key}`, value ? "1" : "0");
  } catch {
    // ignore storage write failures
  }
}

export function getSchemaCapability(key: SchemaCapabilityKey): boolean | null {
  if (schemaCapabilityCache.has(key)) {
    return schemaCapabilityCache.get(key) ?? null;
  }

  const storedValue = readCapabilityFromStorage(key);
  const defaultValue = DEFAULT_SCHEMA_CAPABILITIES[key];
  if (storedValue === null) {
    schemaCapabilityCache.set(key, defaultValue);
    return defaultValue;
  }

  schemaCapabilityCache.set(key, storedValue);
  return storedValue;
}

export function setSchemaCapability(key: SchemaCapabilityKey, value: boolean): void {
  schemaCapabilityCache.set(key, value);
  writeCapabilityToStorage(key, value);
}
