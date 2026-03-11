import net from "node:net";
import process from "node:process";
import { createServer } from "vite";
import { createDevLogger, getDevSymbols, printDivider, printHeader } from "./dev-logger.mjs";

const symbols = getDevSymbols();

function hasExternalPrefix() {
  return process.argv.includes("--external-prefix");
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

async function main() {
  const usesExternalPrefix = hasExternalPrefix();
  const webLog = createDevLogger("WEB", { externalPrefix: usesExternalPrefix });

  if (!usesExternalPrefix) {
    printHeader("Messly Dev Environment");
    printDivider(24);
  }

  const host = "127.0.0.1";
  const port = 5173;
  const alreadyRunning = await isPortReachable(host, port);
  if (alreadyRunning) {
    webLog.warn(`Port 5173 already in use; reusing existing server ${symbols.ARROW} http://127.0.0.1:5173/`);
    await waitForShutdown();
    process.exit(0);
    return;
  }

  const server = await createServer({
    clearScreen: false,
    logLevel: "silent",
    server: {
      host,
      port,
      strictPort: true,
    },
  });

  await server.listen();
  const localUrl = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";
  webLog.fast(`Vite ready ${symbols.ARROW} ${localUrl}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  const webLog = createDevLogger("WEB", { externalPrefix: hasExternalPrefix() });
  const message = error instanceof Error ? error.message : String(error);
  webLog.error(`Web server failed: ${message}`);
  process.exit(1);
});
