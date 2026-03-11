import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const releaseDir = resolve(projectRoot, "release");
const winUnpackedDir = resolve(releaseDir, "win-unpacked");
const asarPath = resolve(winUnpackedDir, "resources", "app.asar");
const latestYmlPath = resolve(releaseDir, "latest.yml");

function fail(message) {
  process.stderr.write(`[release:verify] ${message}\n`);
  process.exit(1);
}

if (!existsSync(releaseDir)) {
  fail("Release directory not found. Run packaging first.");
}

const releaseFiles = readdirSync(releaseDir, {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

const setupExe = releaseFiles.find((fileName) => /^messly-setup\.exe$/i.test(fileName));
if (!setupExe) {
  fail("NSIS setup executable not found in release/.");
}

if (!existsSync(latestYmlPath)) {
  fail("latest.yml not found. Updater metadata is required for electron-updater.");
}

if (!existsSync(winUnpackedDir)) {
  fail("win-unpacked directory not found.");
}

if (!existsSync(asarPath)) {
  fail("app.asar not found in win-unpacked/resources.");
}

process.stdout.write("[release:verify] Release artifacts look valid.\n");
process.stdout.write(`[release:verify] Installer: ${setupExe}\n`);
process.stdout.write("[release:verify] Metadata: latest.yml\n");
process.stdout.write("[release:verify] Runtime: win-unpacked/resources/app.asar\n");
