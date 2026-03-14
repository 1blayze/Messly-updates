# Messly Desktop Release (Windows)

## Shared Runtime Architecture

Messly now ships in three separate parts:

1. `MesslySetup.exe` (bootstrap installer)
2. `messly-runtime-win32-x64.zip` (Electron runtime)
3. `messly-app-win32-x64.zip` (Messly application payload)

The bootstrap installer writes files to:

- `%LOCALAPPDATA%\Messly\runtime`
- `%LOCALAPPDATA%\Messly\app`
- `%LOCALAPPDATA%\Messly\MesslyLauncher.exe`

The launcher starts the desktop app with:

`runtime\Messly.exe app\app.asar`

## Runtime Responsibilities

- `MesslySetup.exe`:
  - creates `%LOCALAPPDATA%\Messly` directories
  - saves launcher config
  - installs launcher executable
  - installs/updates runtime package
  - installs/updates app package
  - launches `MesslyLauncher.exe --launcher`
- `MesslyLauncher.exe --launcher`:
  - validates runtime and app installation
  - checks remote manifests for runtime/app updates
  - updates runtime and app independently
  - launches Electron runtime with Messly app payload

## Build and Release Commands

- Build local shared-runtime artifacts:
  - `npm run package:win`
- Verify generated artifacts:
  - `npm run release:verify`
- Build and publish artifacts to GitHub release:
  - `npm run release:win`

Legacy (electron-updater/nsis-web) commands remain available:

- `npm run package:win:legacy`
- `npm run release:win:legacy`
- `npm run release:verify:legacy`

## Generated Artifacts

Under `release/shared-runtime/artifacts/`:

- `MesslySetup.exe`
- `messly-runtime-win32-x64.zip`
- `messly-app-win32-x64.zip`
- `runtime-manifest.json`
- `app-manifest.json`
- `size-report.json`

## Manifest URLs (Default)

Bootstrap + launcher default to:

- `https://github.com/1blayze/Messly-updates/releases/latest/download/runtime-manifest.json`
- `https://github.com/1blayze/Messly-updates/releases/latest/download/app-manifest.json`

Can be overridden with:

- `MESSLY_RUNTIME_MANIFEST_URL`
- `MESSLY_APP_MANIFEST_URL`

## Publish Variables

For `npm run release:win`, optional environment variables:

- `GH_TOKEN` (or `GITHUB_TOKEN` / `MESSLY_UPDATER_TOKEN`)
- `MESSLY_RELEASE_OWNER` (default: `1blayze`)
- `MESSLY_RELEASE_REPO` (default: `Messly-updates`)
- `MESSLY_RELEASE_TAG` (default: `v<appVersion>`)
- `MESSLY_RELEASE_NAME` (default: `Messly <appVersion>`)
- `MESSLY_RELEASE_BASE_URL` (default points to `releases/latest/download`)

## Size Report

Each build writes `release/shared-runtime/artifacts/size-report.json` with:

- previous installer footprint (legacy baseline)
- bootstrap installer size
- runtime package size
- app package size
