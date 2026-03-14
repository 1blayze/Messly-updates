import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const projectRoot = process.cwd();
const artifactsDir = resolve(projectRoot, "release", "shared-runtime", "artifacts");
const requiredFiles = [
  "MesslySetup.exe",
  "messly-runtime-win32-x64.zip",
  "messly-app-win32-x64.zip",
  "runtime-manifest.json",
  "app-manifest.json",
  "size-report.json",
];
const maxBootstrapSizeBytes = 120 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`[release:verify-shared-runtime] ${message}\n`);
  process.exit(1);
}

if (!existsSync(artifactsDir)) {
  fail(`Artifacts directory not found: ${artifactsDir}`);
}

for (const fileName of requiredFiles) {
  const targetPath = join(artifactsDir, fileName);
  if (!existsSync(targetPath)) {
    fail(`Required artifact missing: ${targetPath}`);
  }
}

const setupPath = join(artifactsDir, "MesslySetup.exe");
const setupSize = statSync(setupPath).size;
if (!Number.isFinite(setupSize) || setupSize <= 0) {
  fail("Bootstrap installer is empty.");
}
if (setupSize > maxBootstrapSizeBytes) {
  fail(
    `Bootstrap installer is larger than expected (${setupSize} bytes > ${maxBootstrapSizeBytes} bytes).`,
  );
}

const runtimeManifest = readJson(join(artifactsDir, "runtime-manifest.json"));
const appManifest = readJson(join(artifactsDir, "app-manifest.json"));

validateManifest(runtimeManifest, "runtime");
validateManifest(appManifest, "app");

validatePackageAgainstManifest(artifactsDir, runtimeManifest, "runtime");
validatePackageAgainstManifest(artifactsDir, appManifest, "app");

process.stdout.write("[release:verify-shared-runtime] Shared runtime artifacts look valid.\n");
process.stdout.write(`[release:verify-shared-runtime] Artifacts dir: ${artifactsDir}\n`);
process.stdout.write(`[release:verify-shared-runtime] Bootstrap size: ${setupSize} bytes\n`);
process.stdout.write(
  `[release:verify-shared-runtime] Runtime package: ${runtimeManifest.package.name} (${runtimeManifest.package.size} bytes)\n`,
);
process.stdout.write(
  `[release:verify-shared-runtime] App package: ${appManifest.package.name} (${appManifest.package.size} bytes)\n`,
);

function readJson(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function validateManifest(manifest, expectedKind) {
  if (!manifest || typeof manifest !== "object") {
    fail(`Invalid ${expectedKind} manifest payload.`);
  }
  if (String(manifest.kind ?? "").trim().toLowerCase() !== expectedKind) {
    fail(`${expectedKind} manifest has incorrect kind field.`);
  }
  if (!String(manifest.version ?? "").trim()) {
    fail(`${expectedKind} manifest missing version.`);
  }
  const pkg = manifest.package;
  if (!pkg || typeof pkg !== "object") {
    fail(`${expectedKind} manifest missing package section.`);
  }
  if (!String(pkg.name ?? "").trim()) {
    fail(`${expectedKind} manifest missing package name.`);
  }
  if (!String(pkg.sha256 ?? "").trim()) {
    fail(`${expectedKind} manifest missing package sha256.`);
  }
  if (!Number.isFinite(Number(pkg.size ?? 0)) || Number(pkg.size) <= 0) {
    fail(`${expectedKind} manifest has invalid package size.`);
  }
}

function validatePackageAgainstManifest(artifactsPath, manifest, expectedKind) {
  const packageName = String(manifest.package.name ?? "").trim();
  const packagePath = join(artifactsPath, packageName);
  if (!existsSync(packagePath)) {
    fail(`${expectedKind} package from manifest not found: ${packagePath}`);
  }

  const realSize = statSync(packagePath).size;
  if (realSize !== Number(manifest.package.size)) {
    fail(
      `${expectedKind} package size mismatch. Manifest=${manifest.package.size}, file=${realSize}.`,
    );
  }

  const realSha = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
  const expectedSha = normalizeSha(String(manifest.package.sha256 ?? ""));
  if (realSha !== expectedSha) {
    fail(`${expectedKind} package SHA mismatch.`);
  }
}

function normalizeSha(rawSha) {
  const trimmed = String(rawSha ?? "").trim().toLowerCase();
  if (trimmed.startsWith("sha256:")) {
    return trimmed.slice("sha256:".length);
  }
  return trimmed;
}
