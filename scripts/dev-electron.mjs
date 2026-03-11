import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import ck from "chalk";
import { getDevSymbols, printDivider, printHeader } from "./dev-logger.mjs";

const symbols = getDevSymbols();
const TAG_COLOR = {
  GATEWAY: "#F59E0B",
  WEB: "#C084FC",
  ELECTRON: "#38BDF8",
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function nowTime() {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function normalizeLine(rawLine) {
  return String(rawLine ?? "").replace(/\r/g, "").trim();
}

function formatPrefix(tag) {
  const color = TAG_COLOR[tag] ?? "#CBD5E1";
  return ck.hex(color)(`[${nowTime()}] ${symbols.STAR} ${tag}`);
}

function writeTagged(tag, message) {
  const line = normalizeLine(message);
  if (!line) {
    return;
  }
  process.stdout.write(`${formatPrefix(tag)} ${line}\n`);
}

function attachStream(tag, stream) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => writeTagged(tag, line));
  return rl;
}

function spawnTaggedProcess(tag, commandText, scriptPath) {
  const childEnv = {
    ...process.env,
    FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
  };

  const child = spawn(process.execPath, [scriptPath, "--external-prefix"], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  attachStream(tag, child.stdout);
  attachStream(tag, child.stderr);

  return {
    tag,
    commandText,
    child,
  };
}

async function waitForExit(processHandle) {
  return new Promise((resolve) => {
    processHandle.child.once("close", (code, signal) => {
      resolve({
        tag: processHandle.tag,
        commandText: processHandle.commandText,
        code: code ?? 0,
        signal: signal ?? null,
      });
    });
  });
}

async function main() {
  printHeader("\u2630 Messly Dev Environment \u2713");
  printDivider(24);

  const processes = [
    spawnTaggedProcess("GATEWAY", "node scripts/dev-gateway.mjs --external-prefix", "scripts/dev-gateway.mjs"),
    spawnTaggedProcess("WEB", "node scripts/dev-web.mjs --external-prefix", "scripts/dev-web.mjs"),
    spawnTaggedProcess("ELECTRON", "node scripts/dev-electron-main.mjs --external-prefix", "scripts/dev-electron-main.mjs"),
  ];

  let hasFailure = false;
  const pending = processes.map((handle) =>
    waitForExit(handle).then((result) => {
      const tagColor = TAG_COLOR[result.tag] ?? "#CBD5E1";

      if (result.signal) {
        writeTagged(result.tag, ck.hex("#F59E0B")(`${symbols.WARN} ${result.commandText} exited by signal ${result.signal}`));
      } else if (result.code === 0) {
        writeTagged(result.tag, ck.hex(tagColor)(`${result.commandText} exited with code 0`));
      } else {
        hasFailure = true;
        writeTagged(result.tag, ck.hex("#EF4444")(`${symbols.ERROR} ${result.commandText} exited with code ${result.code}`));
        for (const handle of processes) {
          if (handle.tag !== result.tag && !handle.child.killed && !handle.child.exitCode) {
            handle.child.kill("SIGTERM");
          }
        }
      }

      return result.code;
    }),
  );

  const codes = await Promise.all(pending);
  if (hasFailure) {
    process.exit(codes.find((code) => code !== 0) ?? 1);
    return;
  }
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeTagged("ELECTRON", ck.hex("#EF4444")(`${symbols.ERROR} ${message}`));
  process.exit(1);
});
