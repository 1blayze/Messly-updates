const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function resolveString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
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

