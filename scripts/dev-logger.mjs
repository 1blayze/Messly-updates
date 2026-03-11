import ck from "chalk";

const SYMBOLS = Object.freeze({
  STAR: "\u2605",
  NODE: "\u2B22",
  FAST: "\u26A1",
  INFO: "\u2022",
  INIT: "\u25C7",
  WARN: "\u25B2",
  ERROR: "\u25A0",
  ARROW: "\u2197",
  VBAR: "\u2502",
  HBAR: "\u2500",
  CORNER: "\u2514",
  TEE: "\u251C",
});

const TAG_COLORS = {
  WEB: "#A855F7",
  ELECTRON: "#60A5FA",
  NODE: "#54A044",
  ENV: "#F59E0B",
  APP: "#CBD5E1",
};

const SYMBOL_COLORS = {
  [SYMBOLS.STAR]: "#E2E8F0",
  [SYMBOLS.NODE]: "#54A044",
  [SYMBOLS.FAST]: "#EAB308",
  [SYMBOLS.INFO]: "#CBD5E1",
  [SYMBOLS.INIT]: "#F59E0B",
  [SYMBOLS.WARN]: "#F59E0B",
  [SYMBOLS.ERROR]: "#EF4444",
  [SYMBOLS.ARROW]: "#94A3B8",
  [SYMBOLS.VBAR]: "#64748B",
  [SYMBOLS.HBAR]: "#64748B",
  [SYMBOLS.CORNER]: "#64748B",
  [SYMBOLS.TEE]: "#64748B",
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getTimeStamp(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function normalizeTag(tag) {
  const value = String(tag || "APP").trim().toUpperCase();
  return value || "APP";
}

function normalizeMessage(message) {
  return String(message || "").replace(/\s+/g, " ").trim();
}

function resolveTagColor(tag) {
  return TAG_COLORS[tag] ?? TAG_COLORS.APP;
}

function resolveSymbolColor(symbol) {
  return SYMBOL_COLORS[symbol] ?? "#CBD5E1";
}

function resolveMessageColor(symbol) {
  if (
    symbol === SYMBOLS.NODE ||
    symbol === SYMBOLS.INIT ||
    symbol === SYMBOLS.WARN ||
    symbol === SYMBOLS.ERROR ||
    symbol === SYMBOLS.FAST
  ) {
    return resolveSymbolColor(symbol);
  }
  return "#E2E8F0";
}

function formatInternalLine(tag, symbol, message) {
  const timestamp = ck.hex("#94A3B8")(`[${getTimeStamp()}]`);
  const marker = ck.hex("#E2E8F0")(SYMBOLS.STAR);
  const tagText = ck.hex(resolveTagColor(tag))(tag);
  const symbolText = ck.hex(resolveSymbolColor(symbol))(symbol);
  const body = ck.hex(resolveMessageColor(symbol))(normalizeMessage(message));
  return `${timestamp} ${marker} ${tagText} ${symbolText} ${body}`;
}

function formatExternalLine(symbol, message) {
  const symbolText = ck.hex(resolveSymbolColor(symbol))(symbol);
  const body = ck.hex(resolveMessageColor(symbol))(normalizeMessage(message));
  return `${symbolText} ${body}`;
}

export function createDevLogger(tag, options = {}) {
  const safeTag = normalizeTag(tag);
  const externalPrefix = options.externalPrefix === true;

  const write = (symbol, message) => {
    const safeMessage = normalizeMessage(message);
    if (!safeMessage) {
      return;
    }
    const line = externalPrefix
      ? formatExternalLine(symbol, safeMessage)
      : formatInternalLine(safeTag, symbol, safeMessage);
    process.stdout.write(`${line}\n`);
  };

  return {
    log: write,
    info: (message) => write(SYMBOLS.INFO, message),
    start: (message) => write(SYMBOLS.INIT, message),
    fast: (message) => write(SYMBOLS.FAST, message),
    warn: (message) => write(SYMBOLS.WARN, message),
    error: (message) => write(SYMBOLS.ERROR, message),
  };
}

export function printHeader(title) {
  const header = ck.hex("#54A044")(normalizeMessage(title));
  process.stdout.write(`${header}\n`);
}

export function printDivider(length = 24) {
  const size = Number.isFinite(length) ? Math.max(8, Math.round(length)) : 24;
  process.stdout.write(`${ck.hex("#475569")(SYMBOLS.HBAR.repeat(size))}\n`);
}

export function getDevSymbols() {
  return SYMBOLS;
}
