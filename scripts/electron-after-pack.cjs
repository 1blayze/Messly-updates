const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DROP_DIRECTORY_NAMES = new Set([
  "test",
  "tests",
  "__tests__",
  "example",
  "examples",
  "docs",
  "doc",
  "benchmark",
  "benchmarks",
  ".github",
  ".vscode",
  "coverage",
]);

const DROP_FILE_EXTENSIONS = new Set([
  ".map",
  ".md",
  ".markdown",
  ".mkd",
  ".mkdn",
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".tsbuildinfo",
]);

const UNPACKED_MODULES_TO_REMOVE = [
  ["ioredis"],
  ["tsx"],
  ["ws"],
  ["@esbuild"],
  ["@supabase"],
  ["zod"],
  ["@img", "sharp-wasm32"],
  ["@img", "sharp-libvips-wasm32"],
];

function resolveString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function removePathIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function shouldDropFileByName(fileName) {
  const normalized = String(fileName ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.endsWith(".d.ts")) {
    return true;
  }

  const ext = path.extname(normalized);
  return DROP_FILE_EXTENSIONS.has(ext);
}

function pruneTree(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const normalizedName = entry.name.toLowerCase();
        if (DROP_DIRECTORY_NAMES.has(normalizedName)) {
          removePathIfExists(fullPath);
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldDropFileByName(entry.name)) {
        removePathIfExists(fullPath);
      }
    }
  }
}

function prunePackagedOutput(appOutDir) {
  const unpackedRoot = path.join(appOutDir, "resources", "app.asar.unpacked");
  if (!fs.existsSync(unpackedRoot)) {
    return;
  }

  const unpackedNodeModulesPath = path.join(unpackedRoot, "node_modules");
  if (fs.existsSync(unpackedNodeModulesPath)) {
    for (const moduleSegments of UNPACKED_MODULES_TO_REMOVE) {
      removePathIfExists(path.join(unpackedNodeModulesPath, ...moduleSegments));
    }
  }

  pruneTree(unpackedRoot);
}

module.exports = async function afterPack(context) {
  if (!context || context.electronPlatformName !== "win32") {
    return;
  }

  const projectDir = context.packager?.projectDir ?? process.cwd();
  const productName = resolveString(context.packager?.appInfo?.productName, "Messly");
  const executableName = resolveString(context.packager?.appInfo?.productFilename, productName);
  const appVersion = resolveString(context.packager?.appInfo?.version, "0.0.0");
  const exePath = path.join(context.appOutDir, `${executableName}.exe`);
  const iconPath = path.join(projectDir, "assets", "icons", "messly.ico");
  const rceditPath = path.join(projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

  prunePackagedOutput(context.appOutDir);

  if (!fs.existsSync(exePath)) {
    throw new Error(`[afterPack] Executable not found: ${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[afterPack] Icon not found: ${iconPath}`);
  }
  if (!fs.existsSync(rceditPath)) {
    throw new Error(`[afterPack] rcedit not found: ${rceditPath}`);
  }

  const result = spawnSync(
    rceditPath,
    [
      exePath,
      "--set-icon",
      iconPath,
      "--set-file-version",
      appVersion,
      "--set-product-version",
      appVersion,
      "--set-version-string",
      "FileDescription",
      productName,
      "--set-version-string",
      "ProductName",
      productName,
      "--set-version-string",
      "InternalName",
      executableName,
      "--set-version-string",
      "OriginalFilename",
      `${executableName}.exe`,
      "--set-version-string",
      "CompanyName",
      resolveString(context.packager?.appInfo?.companyName, "Messly"),
    ],
    {
      cwd: projectDir,
      windowsHide: true,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`[afterPack] rcedit failed with exit code ${result.status}`);
  }
};
