export interface KnownAccount {
  uid: string;
  email: string;
  alias: string;
  avatarSrc: string | null;
  lastUsedAt: number;
}

interface KnownAccountUpdate {
  uid: string;
  email?: string | null;
  alias?: string | null;
  avatarSrc?: string | null;
  touchLastUsedAt?: boolean;
}

const KNOWN_ACCOUNTS_STORAGE_KEY = "messly:known-accounts:v1";

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined";
}

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function deriveAliasFromEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return "perfil";
  }

  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) | 0;
  }

  const suffix = Math.abs(hash).toString(36).slice(0, 4);
  return suffix ? `perfil_${suffix}` : "perfil";
}

function normalizeAlias(value: string | null | undefined, fallbackEmail: string): string {
  const alias = String(value ?? "").trim();
  if (alias) {
    return alias;
  }
  return deriveAliasFromEmail(fallbackEmail);
}

function normalizeKnownAccountAvatarSrc(value: string | null | undefined): string | null {
  const avatarSrc = String(value ?? "").trim();
  if (!avatarSrc || avatarSrc.startsWith("data:image/svg+xml,")) {
    return null;
  }
  return avatarSrc;
}

function normalizeKnownAccount(candidate: Partial<KnownAccount> | null | undefined): KnownAccount | null {
  if (!candidate) {
    return null;
  }

  const uid = String(candidate.uid ?? "").trim();
  const email = normalizeEmail(candidate.email);
  if (!uid || !email) {
    return null;
  }

  const alias = normalizeAlias(candidate.alias, email);
  const avatarSrc = normalizeKnownAccountAvatarSrc(candidate.avatarSrc);
  const lastUsedAtRaw = Number(candidate.lastUsedAt ?? Date.now());
  const lastUsedAt = Number.isFinite(lastUsedAtRaw) ? Math.max(0, Math.floor(lastUsedAtRaw)) : Date.now();

  return {
    uid,
    email,
    alias,
    avatarSrc,
    lastUsedAt,
  };
}

function sortKnownAccounts(accounts: KnownAccount[]): KnownAccount[] {
  return [...accounts].sort((accountA, accountB) => accountB.lastUsedAt - accountA.lastUsedAt);
}

function dedupeKnownAccounts(accounts: KnownAccount[]): KnownAccount[] {
  const sortedAccounts = sortKnownAccounts(accounts);
  const seenUids = new Set<string>();
  const seenEmails = new Set<string>();
  const uniqueAccounts: KnownAccount[] = [];

  for (const account of sortedAccounts) {
    const uid = String(account.uid ?? "").trim();
    const email = normalizeEmail(account.email);
    if (!uid || !email) {
      continue;
    }

    if (seenUids.has(uid) || seenEmails.has(email)) {
      continue;
    }

    seenUids.add(uid);
    seenEmails.add(email);
    uniqueAccounts.push({
      ...account,
      uid,
      email,
    });
  }

  return uniqueAccounts;
}

function readKnownAccountsRaw(): KnownAccount[] {
  if (!isBrowserRuntime()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(KNOWN_ACCOUNTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed
      .map((entry) => normalizeKnownAccount(entry as Partial<KnownAccount>))
      .filter((entry): entry is KnownAccount => entry !== null);

    const deduped = dedupeKnownAccounts(normalized);
    if (raw !== JSON.stringify(deduped)) {
      persistKnownAccounts(deduped);
    }
    return deduped;
  } catch {
    return [];
  }
}

function persistKnownAccounts(accounts: KnownAccount[]): void {
  if (!isBrowserRuntime()) {
    return;
  }

  try {
    window.localStorage.setItem(KNOWN_ACCOUNTS_STORAGE_KEY, JSON.stringify(dedupeKnownAccounts(accounts)));
  } catch {
    // ignore storage write failures
  }
}

export function readKnownAccounts(): KnownAccount[] {
  return readKnownAccountsRaw();
}

export function upsertKnownAccount(update: KnownAccountUpdate): KnownAccount[] {
  const uid = String(update.uid ?? "").trim();
  if (!uid) {
    return readKnownAccountsRaw();
  }

  const accounts = readKnownAccountsRaw();
  const currentTimestamp = Date.now();
  const existingIndex = accounts.findIndex((account) => account.uid === uid);
  const existingAccount = existingIndex >= 0 ? accounts[existingIndex] : null;
  const normalizedEmail = normalizeEmail(update.email ?? existingAccount?.email ?? "");
  if (!normalizedEmail) {
    return sortKnownAccounts(accounts);
  }

  const mergedAccount = normalizeKnownAccount({
    uid,
    email: normalizedEmail,
    alias: update.alias ?? existingAccount?.alias ?? deriveAliasFromEmail(normalizedEmail),
    avatarSrc:
      typeof update.avatarSrc === "string" || update.avatarSrc === null
        ? update.avatarSrc
        : existingAccount?.avatarSrc ?? null,
    lastUsedAt: update.touchLastUsedAt ?? true ? currentTimestamp : existingAccount?.lastUsedAt ?? currentTimestamp,
  });

  if (!mergedAccount) {
    return sortKnownAccounts(accounts);
  }

  if (existingIndex >= 0) {
    accounts[existingIndex] = mergedAccount;
  } else {
    accounts.push(mergedAccount);
  }

  const sortedAccounts = sortKnownAccounts(accounts);
  persistKnownAccounts(sortedAccounts);
  return sortedAccounts;
}

export function removeKnownAccount(uidRaw: string): KnownAccount[] {
  const uid = String(uidRaw ?? "").trim();
  if (!uid) {
    return readKnownAccountsRaw();
  }

  const nextAccounts = readKnownAccountsRaw().filter((account) => account.uid !== uid);
  persistKnownAccounts(nextAccounts);
  return nextAccounts;
}
