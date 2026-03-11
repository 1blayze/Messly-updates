import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

const shouldPublish = process.argv.includes("--publish");
const publishMode = shouldPublish ? "always" : "never";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = String(process.env.npm_execpath ?? "").trim();

dotenv.config({
  path: resolve(process.cwd(), ".env"),
  quiet: true,
});
dotenv.config({
  path: resolve(process.cwd(), ".env.local"),
  override: true,
  quiet: true,
});

const githubToken =
  String(
    process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.MESSLY_UPDATER_TOKEN ??
      "",
  ).trim() || "";

if (githubToken && !process.env.GH_TOKEN) {
  process.env.GH_TOKEN = githubToken;
}

const electronBuilderCliPath = resolve(
  process.cwd(),
  "node_modules/electron-builder/cli.js",
);

if (shouldPublish && !process.env.GH_TOKEN) {
  process.stderr.write("[release] Missing GitHub token for publish mode.\n");
  process.stderr.write("[release] Set GH_TOKEN (or GITHUB_TOKEN / MESSLY_UPDATER_TOKEN) and rerun.\n");
  process.stderr.write("[release] If you only need installer generation, run: npm run package:win\n");
  process.exit(1);
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
    },
  });
  if (result.error) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    process.stderr.write(`[release] Failed to run command: ${command} ${args.join(" ")}\n`);
    process.stderr.write(`[release] ${message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (npmExecPath) {
  runOrThrow(process.execPath, [npmExecPath, "run", "build:desktop"]);
} else {
  runOrThrow(npmCommand, ["run", "build:desktop"]);
}

if (!existsSync(electronBuilderCliPath)) {
  process.stderr.write(`[release] electron-builder CLI not found at ${electronBuilderCliPath}\n`);
  process.exit(1);
}
runOrThrow(process.execPath, [electronBuilderCliPath, "--win", "nsis", "--publish", publishMode]);

if (npmExecPath) {
  runOrThrow(process.execPath, [npmExecPath, "run", "release:verify"]);
} else {
  runOrThrow(npmCommand, ["run", "release:verify"]);
}
