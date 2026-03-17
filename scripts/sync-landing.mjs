import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const sourceDir = join(projectRoot, "landing");
const targetDir = join(projectRoot, "public", "landing");

if (!existsSync(sourceDir)) {
  throw new Error(`Landing source directory not found: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });

for (const entry of readdirSync(targetDir)) {
  rmSync(join(targetDir, entry), { recursive: true, force: true });
}

for (const entry of readdirSync(sourceDir)) {
  cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true });
}

console.log("[sync-landing] Synced landing -> public/landing");
