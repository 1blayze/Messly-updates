export type LoggerLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

interface LogPayload {
  component: string;
  level: LoggerLevel;
  message: string;
  [key: string]: unknown;
}

function resolveLogWriter(level: LoggerLevel): (message: string, ...meta: unknown[]) => void {
  switch (level) {
    case "error":
      return console.error;
    case "warn":
      return console.warn;
    case "debug":
      return console.debug;
    default:
      return console.info;
  }
}

function normalizeMeta(meta: unknown[]): Record<string, unknown> {
  if (meta.length === 0) {
    return {};
  }
  if (meta.length === 1 && typeof meta[0] === "object" && meta[0] !== null) {
    return meta[0] as Record<string, unknown>;
  }

  return {
    meta: meta.map((entry) => entry),
  };
}

class ConsoleLogger implements Logger {
  constructor(private readonly component: string) {}

  debug(message: string, ...meta: unknown[]): void {
    if (process.env.NODE_ENV === "production") {
      return;
    }
    this.write("debug", message, ...meta);
  }

  info(message: string, ...meta: unknown[]): void {
    this.write("info", message, ...meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this.write("warn", message, ...meta);
  }

  error(message: string, ...meta: unknown[]): void {
    this.write("error", message, ...meta);
  }

  private write(level: LoggerLevel, message: string, ...meta: unknown[]): void {
    const payload: LogPayload = {
      component: this.component,
      level,
      message,
      timestamp: new Date().toISOString(),
      ...normalizeMeta(meta),
    };
    resolveLogWriter(level)(JSON.stringify(payload));
  }
}

export function createLogger(component: string): Logger {
  return new ConsoleLogger(component);
}
