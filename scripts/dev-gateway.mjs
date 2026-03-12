import net from "node:net";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import "dotenv/config";
import { createDevLogger, getDevSymbols } from "./dev-logger.mjs";

const symbols = getDevSymbols();
const hasExternalPrefix = process.argv.includes("--external-prefix");
const gatewayLog = createDevLogger("GATEWAY", { externalPrefix: hasExternalPrefix });
const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 8788;

function parseBoolean(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveConfiguredGatewayUrl() {
  const fromServer = String(process.env.MESSLY_GATEWAY_PUBLIC_URL ?? "").trim();
  if (fromServer) {
    return fromServer;
  }
  return String(process.env.VITE_MESSLY_GATEWAY_URL ?? "").trim();
}

function isLocalGatewayUrl(urlRaw) {
  const urlValue = String(urlRaw ?? "").trim();
  if (!urlValue) {
    return true;
  }

  try {
    const parsed = new URL(urlValue);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
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

function isPortReachable(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function isMesslyGatewayHealthy(host, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);

  try {
    const response = await fetch(`http://${host}:${port}/`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return false;
    }

    const payload = await response.json().catch(() => null);
    return payload?.service === "messly-gateway" && payload?.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForShutdown() {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);
    const done = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function resolveGatewayLaunchCommand() {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm exec tsx -- server/src/index.ts"],
    };
  }

  return {
    command: "npm",
    args: ["exec", "tsx", "--", "server/src/index.ts"],
  };
}

async function main() {
  const forceLocalGateway = parseBoolean(process.env.MESSLY_DEV_FORCE_LOCAL_GATEWAY);
  const configuredGatewayUrl = resolveConfiguredGatewayUrl();
  if (!forceLocalGateway && configuredGatewayUrl && !isLocalGatewayUrl(configuredGatewayUrl)) {
    gatewayLog.warn(
      `Remote gateway configured (${configuredGatewayUrl}); skipping local gateway bootstrap.`,
    );
    await waitForShutdown();
    process.exit(0);
    return;
  }

  const alreadyRunning = await isPortReachable(GATEWAY_HOST, GATEWAY_PORT);
  if (alreadyRunning) {
    const healthy = await isMesslyGatewayHealthy(GATEWAY_HOST, GATEWAY_PORT);
    if (!healthy) {
      throw new Error(`Port ${GATEWAY_PORT} is already in use by another process.`);
    }

    gatewayLog.warn(
      `Port ${GATEWAY_PORT} already in use; reusing existing gateway ${symbols.ARROW} http://${GATEWAY_HOST}:${GATEWAY_PORT}/`,
    );
    await waitForShutdown();
    process.exit(0);
    return;
  }

  const launch = resolveGatewayLaunchCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  gatewayLog.log(symbols.NODE, "Gateway/auth server started");

  pipeStreamLines(child.stdout, (rawLine) => {
    const line = normalizeOutputLine(rawLine);
    if (!line) {
      return;
    }
    if (/\berror\b|err_/i.test(line)) {
      gatewayLog.error(line);
      return;
    }
    if (/\bwarn(?:ing)?\b/i.test(line)) {
      gatewayLog.warn(line);
      return;
    }
    gatewayLog.info(line);
  });

  pipeStreamLines(child.stderr, (rawLine) => {
    const line = normalizeOutputLine(rawLine);
    if (!line) {
      return;
    }
    if (/\bwarn(?:ing)?\b/i.test(line)) {
      gatewayLog.warn(line);
      return;
    }
    gatewayLog.error(line);
  });

  child.once("close", (code, signal) => {
    if (signal) {
      gatewayLog.warn(`Gateway exited by signal ${signal}`);
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  gatewayLog.error(`Bootstrap failed: ${message}`);
  process.exit(1);
});
