export type LoggerSymbol =
  | "★"
  | "⬢"
  | "⚡"
  | "•"
  | "◇"
  | "▲"
  | "■"
  | "→"
  | "│"
  | "─"
  | "└"
  | "├";

export type LoggerLevel = "info" | "warn" | "error";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function getLoggerTimestamp(date: Date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatLoggerLine(tag: string, symbol: LoggerSymbol, message: string, date: Date = new Date()): string {
  const safeTag = (tag || "APP").trim().toUpperCase();
  const safeMessage = (message || "").trim();
  return `[${getLoggerTimestamp(date)}] ★ ${safeTag} ${symbol} ${safeMessage}`;
}

export function createLogger(tag: string) {
  const safeTag = (tag || "APP").trim().toUpperCase();

  const write = (symbol: LoggerSymbol, message: string, level: LoggerLevel = "info"): void => {
    const line = formatLoggerLine(safeTag, symbol, message);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  };

  return {
    info: (symbol: LoggerSymbol, message: string) => write(symbol, message, "info"),
    warn: (symbol: LoggerSymbol, message: string) => write(symbol, message, "warn"),
    error: (symbol: LoggerSymbol, message: string) => write(symbol, message, "error"),
  };
}
