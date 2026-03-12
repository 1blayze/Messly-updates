export type LoggerLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LoggerLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: LoggerLevel,
    private readonly bindings: Record<string, unknown>,
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.level, {
      ...this.bindings,
      ...bindings,
    });
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LoggerLevel, message: string, fields: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      severity: level.toUpperCase(),
      message,
      ...this.bindings,
      ...fields,
    };
    const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    writer(JSON.stringify(payload));
  }
}

export function createLogger(component: string, level: LoggerLevel = "info"): Logger {
  return new JsonLogger(level, { component });
}
