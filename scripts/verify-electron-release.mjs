import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const releaseDir = resolve(projectRoot, "release");
const requestedTarget = String(process.env.MESSLY_WINDOWS_TARGET ?? "nsis-web").trim().toLowerCase() || "nsis-web";
const nsisWebDir = resolve(releaseDir, "nsis-web");
const artifactsDir = requestedTarget === "nsis-web" ? nsisWebDir : releaseDir;
const winUnpackedDir = resolve(releaseDir, "win-unpacked");
const asarPath = resolve(winUnpackedDir, "resources", "app.asar");
const maxBootstrapSizeBytes = 35 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`[release:verify] ${message}\n`);
  process.exit(1);
}

if (!existsSync(releaseDir)) {
  fail("Release directory not found. Run packaging first.");
}

if (!existsSync(artifactsDir)) {
  fail(`Target artifacts directory not found: ${artifactsDir}`);
}

const releaseFiles = readdirSync(artifactsDir, {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

const setupExe = releaseFiles.find((fileName) => /^messly-setup\.exe$/i.test(fileName));
if (!setupExe) {
  fail("NSIS setup executable not found in release/.");
}

const webPackage = releaseFiles.find((fileName) => /\.nsis\.(7z|zip)$/i.test(fileName));
if (!webPackage) {
  fail("NSIS web package (.nsis.7z/.nsis.zip) not found in release/. Bootstrap installer target is likely misconfigured.");
}

const setupExePath = resolve(artifactsDir, setupExe);
const setupExeStats = statSync(setupExePath);
if (!Number.isFinite(setupExeStats.size) || setupExeStats.size <= 0) {
  fail("NSIS setup executable is empty.");
}
if (setupExeStats.size > maxBootstrapSizeBytes) {
  fail(
    `Bootstrap installer is larger than expected (${setupExeStats.size} bytes > ${maxBootstrapSizeBytes} bytes). Expected nsis-web lightweight setup.`,
  );
}

const latestYmlPathFromArtifactsDir = resolve(artifactsDir, "latest.yml");
const latestYmlPathFallback = resolve(releaseDir, "latest.yml");
const latestYmlPath = existsSync(latestYmlPathFromArtifactsDir)
  ? latestYmlPathFromArtifactsDir
  : latestYmlPathFallback;

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
process.stdout.write(`[release:verify] Target: ${requestedTarget}\n`);
process.stdout.write(`[release:verify] Artifacts dir: ${artifactsDir}\n`);
process.stdout.write(`[release:verify] Installer: ${setupExe}\n`);
process.stdout.write(`[release:verify] App package: ${webPackage}\n`);
process.stdout.write(`[release:verify] Bootstrap size: ${setupExeStats.size} bytes\n`);
process.stdout.write(`[release:verify] Metadata: ${latestYmlPath}\n`);
process.stdout.write("[release:verify] Runtime: win-unpacked/resources/app.asar\n");
