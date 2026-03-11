import net from "node:net";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import electronPathModule from "electron";
import { createDevLogger, getDevSymbols } from "./dev-logger.mjs";

const symbols = getDevSymbols();
const hasExternalPrefix = process.argv.includes("--external-prefix");

const electronLog = createDevLogger("ELECTRON", { externalPrefix: hasExternalPrefix });
const envLog = createDevLogger("ENV", { externalPrefix: hasExternalPrefix });
const nodeLog = createDevLogger("NODE", { externalPrefix: hasExternalPrefix });

function isConnected(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForTcpPort({ host, port, timeoutMs = 60_000, retryDelayMs = 250 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isConnected(host, port)) {
      return;
    }
    await delay(retryDelayMs);
  }
  throw new Error(`Timeout while waiting for ${host}:${port}.`);
}

function normalizeOutputLine(rawLine) {
  const line = String(rawLine ?? "").replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!line) {
    return "";
  }
  if (line.includes("[dotenv@")) {
    return "";
  }
  return line;
}

function pipeStreamLines(stream, onLine) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => onLine(line));
}

function resolveElectronExecutablePath() {
  if (typeof electronPathModule === "string") {
    return electronPathModule;
  }
  if (electronPathModule && typeof electronPathModule.default === "string") {
    return electronPathModule.default;
  }
  return "";
}

async function main() {
  const host = "127.0.0.1";
  const port = 5173;
  await waitForTcpPort({ host, port });

  envLog.start("Variables loaded");
  nodeLog.log(symbols.NODE, `Node.js ${process.version}`);

  const electronBinary = resolveElectronExecutablePath();
  if (!electronBinary) {
    throw new Error("Electron executable path not resolved.");
  }

  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBinary, ["."], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["inherit", "pipe", "pipe"],
  });

  electronLog.log(symbols.NODE, "Electron started");

  pipeStreamLines(child.stdout, (rawLine) => {
    const line = normalizeOutputLine(rawLine);
    if (!line) {
      return;
    }
    if (/\berror\b|err_/i.test(line)) {
      electronLog.error(line);
      return;
    }
    if (/\bwarn(?:ing)?\b/i.test(line)) {
      electronLog.warn(line);
      return;
    }
    electronLog.info(line);
  });

  pipeStreamLines(child.stderr, (rawLine) => {
    const line = normalizeOutputLine(rawLine);
    if (!line) {
      return;
    }
    if (/\bwarn(?:ing)?\b/i.test(line)) {
      electronLog.warn(line);
      return;
    }
    electronLog.error(line);
  });

  child.once("close", (code, signal) => {
    if (signal) {
      electronLog.warn(`Electron exited by signal ${signal}`);
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  electronLog.error(`Bootstrap failed: ${message}`);
  process.exit(1);
});
