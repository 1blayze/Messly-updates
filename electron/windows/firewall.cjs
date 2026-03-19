const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_FIREWALL_RULE_NAME = "Azyoon Private Network Access";
const DEFAULT_FIREWALL_PROFILE = "private";
const DEFAULT_NETSH_TIMEOUT_MS = 15_000;

const FIREWALL_PROFILE_VALUES = new Set(["private", "public", "domain", "any"]);
const FIREWALL_PROFILE_LABELS = {
  private: "private",
  public: "public",
  domain: "domain",
  any: "any",
};

function isWindows() {
  return process.platform === "win32";
}

function createLogger(logger) {
  if (!logger || typeof logger !== "object") {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
    };
  }

  const debug = typeof logger.debug === "function" ? logger.debug.bind(logger) : () => {};
  const info = typeof logger.info === "function" ? logger.info.bind(logger) : () => {};
  const warn = typeof logger.warn === "function" ? logger.warn.bind(logger) : () => {};

  return { debug, info, warn };
}

function normalizeRuleName(rawRuleName) {
  const value = String(rawRuleName ?? "").trim();
  return value || DEFAULT_FIREWALL_RULE_NAME;
}

function normalizeExecutablePath(rawPath) {
  const value = String(rawPath ?? "").trim();
  if (!value) {
    return "";
  }
  return path.resolve(value);
}

function normalizePathForCompare(rawPath) {
  const value = normalizeExecutablePath(rawPath);
  if (!value) {
    return "";
  }
  return value.replace(/\//g, "\\").toLowerCase();
}

function netshQuotedValue(value) {
  return `"${String(value ?? "").replace(/"/g, "")}"`;
}

function toCommandLine(args) {
  return `netsh.exe ${args.join(" ")}`;
}

function isNoRuleMatchOutput(text) {
  const normalized = String(text ?? "").toLowerCase();
  return (
    normalized.includes("no rules match") ||
    normalized.includes("nenhuma regra corresponde") ||
    normalized.includes("nao ha regras") ||
    normalized.includes("n�o h� regras")
  );
}

function isPermissionDeniedOutput(text) {
  const normalized = String(text ?? "").toLowerCase();
  return (
    normalized.includes("access is denied") ||
    normalized.includes("acesso negado") ||
    normalized.includes("requires elevation") ||
    normalized.includes("executar este comando em um prompt de comando elevado") ||
    normalized.includes("run this command from an elevated command prompt") ||
    normalized.includes("elevado")
  );
}

async function runNetsh(args, options = {}) {
  const {
    logger,
    timeoutMs = DEFAULT_NETSH_TIMEOUT_MS,
    allowNoRuleMatch = false,
    allowFailure = false,
  } = options;

  const log = createLogger(logger);
  const commandLine = toCommandLine(args);
  log.debug("[firewall] running netsh command", { commandLine });

  try {
    const result = await execFileAsync("netsh.exe", args, {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });

    return {
      ok: true,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      exitCode: 0,
      permissionDenied: false,
      noRuleMatch: false,
    };
  } catch (error) {
    const stdout = String(error?.stdout ?? "");
    const stderr = String(error?.stderr ?? "");
    const combinedOutput = `${stdout}\n${stderr}`;
    const noRuleMatch = isNoRuleMatchOutput(combinedOutput);
    const permissionDenied = isPermissionDeniedOutput(combinedOutput);
    const exitCode = Number.isFinite(Number(error?.code)) ? Number(error.code) : 1;

    if ((allowNoRuleMatch && noRuleMatch) || allowFailure) {
      return {
        ok: false,
        stdout,
        stderr,
        exitCode,
        permissionDenied,
        noRuleMatch,
        error,
      };
    }

    const wrappedError = new Error(`netsh command failed (${exitCode}): ${commandLine}`);
    wrappedError.cause = error;
    wrappedError.stdout = stdout;
    wrappedError.stderr = stderr;
    wrappedError.exitCode = exitCode;
    wrappedError.permissionDenied = permissionDenied;
    wrappedError.noRuleMatch = noRuleMatch;
    throw wrappedError;
  }
}

function parseFirewallRuleEntries(rawOutput, targetRuleName) {
  const normalizedRuleName = normalizeRuleName(targetRuleName).toLowerCase();
  const lines = String(rawOutput ?? "").split(/\r?\n/);
  const entries = [];
  let currentEntry = null;

  const flushCurrentEntry = () => {
    if (!currentEntry) {
      return;
    }
    const ruleName = String(currentEntry.ruleName ?? "").trim();
    if (ruleName.toLowerCase() === normalizedRuleName) {
      entries.push(currentEntry);
    }
    currentEntry = null;
  };

  for (const line of lines) {
    const ruleNameMatch = line.match(/^\s*Rule Name\s*:\s*(.+)$/i);
    if (ruleNameMatch) {
      flushCurrentEntry();
      currentEntry = {
        ruleName: String(ruleNameMatch[1] ?? "").trim(),
        direction: "",
        profiles: "",
        program: "",
        enabled: "",
      };
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    const fieldMatch = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (!fieldMatch) {
      continue;
    }

    const key = String(fieldMatch[1] ?? "").trim().toLowerCase();
    const value = String(fieldMatch[2] ?? "").trim();

    if (key === "direction") {
      currentEntry.direction = value;
      continue;
    }
    if (key === "profiles") {
      currentEntry.profiles = value;
      continue;
    }
    if (key === "program") {
      currentEntry.program = value;
      continue;
    }
    if (key === "enabled") {
      currentEntry.enabled = value;
    }
  }

  flushCurrentEntry();
  return entries;
}

function parseProfileTokens(rawProfileList) {
  const normalized = String(rawProfileList ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();

  if (!normalized || normalized === "notapplicable") {
    return new Set();
  }

  const tokens = new Set();
  for (const token of normalized.split(",")) {
    if (!token) {
      continue;
    }
    if (token.includes("all")) {
      tokens.add("any");
      continue;
    }
    if (token.includes("private") || token.includes("privada")) {
      tokens.add("private");
      continue;
    }
    if (token.includes("public") || token.includes("publica")) {
      tokens.add("public");
      continue;
    }
    if (token.includes("domain") || token.includes("dominio") || token.includes("dom�nio")) {
      tokens.add("domain");
    }
  }
  return tokens;
}

function normalizeRequestedProfiles(rawProfile, allowPublicProfile) {
  const normalized = String(rawProfile ?? DEFAULT_FIREWALL_PROFILE)
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();

  if (!normalized) {
    return [DEFAULT_FIREWALL_PROFILE];
  }

  const requestedProfiles = normalized.split(",").filter(Boolean);
  const deduplicated = [];

  for (const profileName of requestedProfiles) {
    if (!FIREWALL_PROFILE_VALUES.has(profileName)) {
      continue;
    }
    if (profileName === "public" && !allowPublicProfile) {
      continue;
    }
    if (!deduplicated.includes(profileName)) {
      deduplicated.push(profileName);
    }
  }

  if (deduplicated.length === 0) {
    return [DEFAULT_FIREWALL_PROFILE];
  }

  return deduplicated;
}

function toProfilesArgument(profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return DEFAULT_FIREWALL_PROFILE;
  }
  return profiles.join(",");
}

function areProfilesCompatible(ruleProfiles, expectedProfiles) {
  const existingProfiles = parseProfileTokens(ruleProfiles);
  if (existingProfiles.has("any")) {
    return true;
  }

  for (const expectedProfile of expectedProfiles) {
    if (!existingProfiles.has(expectedProfile)) {
      return false;
    }
  }

  return true;
}

function isEnabledValue(rawEnabled) {
  const normalized = String(rawEnabled ?? "").trim().toLowerCase();
  return normalized === "yes" || normalized === "sim" || normalized === "true";
}

function isInboundDirection(rawDirection) {
  const normalized = String(rawDirection ?? "").trim().toLowerCase();
  return normalized === "in" || normalized === "entrada";
}

function isEntryMatchingTarget(entry, executablePath, expectedProfiles) {
  const entryProgramPath = normalizePathForCompare(entry?.program ?? "");
  const expectedProgramPath = normalizePathForCompare(executablePath);
  return (
    Boolean(entryProgramPath) &&
    entryProgramPath === expectedProgramPath &&
    isInboundDirection(entry?.direction) &&
    isEnabledValue(entry?.enabled) &&
    areProfilesCompatible(entry?.profiles, expectedProfiles)
  );
}

function isEntryPathOutdated(entry, executablePath) {
  const entryProgramPath = normalizePathForCompare(entry?.program ?? "");
  const expectedProgramPath = normalizePathForCompare(executablePath);
  return Boolean(entryProgramPath) && entryProgramPath !== expectedProgramPath;
}

async function getFirewallRuleEntries(options = {}) {
  if (!isWindows()) {
    return [];
  }

  const ruleName = normalizeRuleName(options.ruleName);
  const log = createLogger(options.logger);
  const showResult = await runNetsh(
    [
      "advfirewall",
      "firewall",
      "show",
      "rule",
      `name=${netshQuotedValue(ruleName)}`,
      "verbose",
    ],
    {
      logger: log,
      allowNoRuleMatch: true,
    },
  );

  if (!showResult.ok && showResult.noRuleMatch) {
    return [];
  }

  const output = `${showResult.stdout ?? ""}\n${showResult.stderr ?? ""}`;
  const entries = parseFirewallRuleEntries(output, ruleName);
  log.debug("[firewall] parsed firewall rules", {
    ruleName,
    count: entries.length,
  });
  return entries;
}

async function deleteFirewallRuleByEntry(options) {
  const {
    ruleName,
    entry,
    logger,
  } = options;

  const direction = isInboundDirection(entry?.direction) ? "in" : "any";
  const programPath = String(entry?.program ?? "").trim();

  const args = [
    "advfirewall",
    "firewall",
    "delete",
    "rule",
    `name=${netshQuotedValue(ruleName)}`,
  ];

  if (direction !== "any") {
    args.push(`dir=${direction}`);
  }

  if (programPath) {
    args.push(`program=${netshQuotedValue(programPath)}`);
  }

  return runNetsh(args, {
    logger,
    allowNoRuleMatch: true,
    allowFailure: true,
  });
}

async function removeOutdatedWindowsFirewallRules(options = {}) {
  if (!isWindows()) {
    return {
      removedCount: 0,
      inspectedCount: 0,
      skipped: true,
    };
  }

  const log = createLogger(options.logger);
  const ruleName = normalizeRuleName(options.ruleName);
  const executablePath = normalizeExecutablePath(options.executablePath);
  const existingEntries = await getFirewallRuleEntries({
    ruleName,
    logger: log,
  });

  if (!executablePath) {
    return {
      removedCount: 0,
      inspectedCount: existingEntries.length,
      skipped: true,
      reason: "missing-executable-path",
    };
  }

  const outdatedEntries = existingEntries.filter((entry) => isEntryPathOutdated(entry, executablePath));
  let removedCount = 0;

  for (const entry of outdatedEntries) {
    const deleteResult = await deleteFirewallRuleByEntry({
      ruleName,
      entry,
      logger: log,
    });

    if (!deleteResult.permissionDenied) {
      removedCount += 1;
      log.info("[firewall] removed outdated rule", {
        ruleName,
        program: entry.program,
      });
      continue;
    }

    log.warn("[firewall] unable to remove outdated rule due to insufficient privileges", {
      ruleName,
      program: entry.program,
    });
  }

  return {
    removedCount,
    inspectedCount: existingEntries.length,
    outdatedCount: outdatedEntries.length,
  };
}

function buildFirewallRuleAddArgs(ruleName, executablePath, profiles) {
  return [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    `name=${netshQuotedValue(ruleName)}`,
    "dir=in",
    "action=allow",
    `profile=${toProfilesArgument(profiles)}`,
    "enable=yes",
    `program=${netshQuotedValue(executablePath)}`,
  ];
}

function getInstalledExePath(appLike) {
  const fromApp =
    appLike &&
    typeof appLike.getPath === "function"
      ? String(appLike.getPath("exe") ?? "").trim()
      : "";
  const fromProcess = String(process.execPath ?? "").trim();
  const resolved = normalizeExecutablePath(fromApp || fromProcess);
  return resolved;
}

async function ensureWindowsFirewallRule(options = {}) {
  const log = createLogger(options.logger);

  if (!isWindows()) {
    return {
      status: "skipped",
      reason: "not-windows",
      ruleName: normalizeRuleName(options.ruleName),
      executablePath: "",
      created: false,
      removedOutdatedCount: 0,
    };
  }

  const ruleName = normalizeRuleName(options.ruleName);
  const executablePath = normalizeExecutablePath(options.executablePath);

  if (!executablePath || !executablePath.toLowerCase().endsWith(".exe")) {
    return {
      status: "skipped",
      reason: "invalid-executable-path",
      ruleName,
      executablePath,
      created: false,
      removedOutdatedCount: 0,
    };
  }

  const allowPublicProfile = Boolean(options.allowPublicProfile);
  const profiles = normalizeRequestedProfiles(options.profile, allowPublicProfile);

  log.info("[firewall] ensuring firewall rule", {
    ruleName,
    executablePath,
    profiles,
  });

  const cleanupResult = await removeOutdatedWindowsFirewallRules({
    ruleName,
    executablePath,
    logger: log,
  });

  let entries = await getFirewallRuleEntries({
    ruleName,
    logger: log,
  });

  const hasExpectedRule = entries.some((entry) => isEntryMatchingTarget(entry, executablePath, profiles));
  if (hasExpectedRule) {
    log.info("[firewall] firewall rule already present", {
      ruleName,
      executablePath,
      profiles,
    });
    return {
      status: "ready",
      ruleName,
      executablePath,
      created: false,
      updated: cleanupResult.removedCount > 0,
      removedOutdatedCount: cleanupResult.removedCount,
      profiles,
    };
  }

  const samePathEntries = entries.filter((entry) => {
    const ruleProgramPath = normalizePathForCompare(entry?.program ?? "");
    return ruleProgramPath === normalizePathForCompare(executablePath);
  });

  for (const entry of samePathEntries) {
    await deleteFirewallRuleByEntry({
      ruleName,
      entry,
      logger: log,
    });
  }

  const addResult = await runNetsh(buildFirewallRuleAddArgs(ruleName, executablePath, profiles), {
    logger: log,
    allowFailure: true,
  });

  if (addResult.permissionDenied) {
    log.warn("[firewall] insufficient privileges to create firewall rule", {
      ruleName,
      executablePath,
      profiles,
    });
    return {
      status: "insufficient-privileges",
      ruleName,
      executablePath,
      created: false,
      updated: cleanupResult.removedCount > 0,
      removedOutdatedCount: cleanupResult.removedCount,
      profiles,
    };
  }

  if (!addResult.ok && addResult.exitCode !== 0) {
    log.warn("[firewall] failed to create firewall rule", {
      ruleName,
      executablePath,
      profiles,
      exitCode: addResult.exitCode,
    });
    return {
      status: "failed",
      ruleName,
      executablePath,
      created: false,
      updated: cleanupResult.removedCount > 0,
      removedOutdatedCount: cleanupResult.removedCount,
      profiles,
      exitCode: addResult.exitCode,
    };
  }

  entries = await getFirewallRuleEntries({
    ruleName,
    logger: log,
  });

  const confirmed = entries.some((entry) => isEntryMatchingTarget(entry, executablePath, profiles));
  if (!confirmed) {
    log.warn("[firewall] firewall rule creation could not be confirmed", {
      ruleName,
      executablePath,
      profiles,
    });
    return {
      status: "failed",
      reason: "rule-not-confirmed",
      ruleName,
      executablePath,
      created: true,
      updated: cleanupResult.removedCount > 0,
      removedOutdatedCount: cleanupResult.removedCount,
      profiles,
    };
  }

  log.info("[firewall] firewall rule created", {
    ruleName,
    executablePath,
    profiles,
  });

  return {
    status: "ready",
    ruleName,
    executablePath,
    created: true,
    updated: cleanupResult.removedCount > 0,
    removedOutdatedCount: cleanupResult.removedCount,
    profiles,
  };
}

async function collectWindowsNetworkDiagnostics(options = {}) {
  const ruleName = normalizeRuleName(options.ruleName);
  const executablePath = normalizeExecutablePath(options.executablePath);
  const allowPublicProfile = Boolean(options.allowPublicProfile);
  const profiles = normalizeRequestedProfiles(options.profile, allowPublicProfile);
  const logger = createLogger(options.logger);

  if (!isWindows()) {
    return {
      platform: process.platform,
      timestamp: new Date().toISOString(),
      ruleName,
      executablePath,
      supported: false,
      reason: "not-windows",
    };
  }

  const profileCheckResult = await runNetsh([
    "advfirewall",
    "show",
    "currentprofile",
  ], {
    logger,
    allowFailure: true,
  });

  const entries = await getFirewallRuleEntries({
    ruleName,
    logger,
  });

  const hasExpectedRule = entries.some((entry) => isEntryMatchingTarget(entry, executablePath, profiles));

  return {
    platform: process.platform,
    timestamp: new Date().toISOString(),
    ruleName,
    executablePath,
    expectedProfiles: profiles.map((profile) => FIREWALL_PROFILE_LABELS[profile] ?? profile),
    hasExpectedRule,
    currentProfileRaw: `${profileCheckResult.stdout ?? ""}\n${profileCheckResult.stderr ?? ""}`.trim(),
    firewallRules: entries.map((entry) => ({
      ruleName: entry.ruleName,
      direction: entry.direction,
      profiles: entry.profiles,
      program: entry.program,
      enabled: entry.enabled,
    })),
  };
}

module.exports = {
  DEFAULT_FIREWALL_RULE_NAME,
  DEFAULT_FIREWALL_PROFILE,
  getInstalledExePath,
  ensureWindowsFirewallRule,
  removeOutdatedWindowsFirewallRules,
  collectWindowsNetworkDiagnostics,
};
