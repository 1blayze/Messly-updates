# Messly Desktop Release (Windows)

## Official Updater Path
- Official production updater: `electron-updater` adapter in `electron/update/electronUpdaterAdapter.cjs`.
- Legacy fallback updater: GitHub API updater in `electron/update/appUpdater.cjs`.
- Runtime selector:
  - default: `MESSLY_UPDATER_PROVIDER=electron-updater`
  - fallback: `MESSLY_UPDATER_PROVIDER=github-api`

## Build and Installer Commands
- Package local installer:
  - `npm run package:win`
- Publish release-compatible build:
  - `npm run release:win`
- Validate generated artifacts:
  - `npm run release:verify`

## Expected Artifacts
- `release/messly-setup.exe`
- `release/latest.yml`
- `release/win-unpacked/resources/app.asar`

## Branding and Identity
- Product name: `Messly`
- App ID: `com.messly.app`
- Executable: `Messly.exe`
- Installer shortcuts/uninstaller display: `Messly`

## Environment Variables (optional)
- `MESSLY_UPDATER_PROVIDER` (`electron-updater` or `github-api`)
- `MESSLY_UPDATER_OWNER` (default `1blayze`)
- `MESSLY_UPDATER_REPO` (default `Messly-updates`)
- `MESSLY_UPDATER_TOKEN` (optional, for private repo/rate-limit handling)
- `AUTO_UPDATE_INSTALL_ON_STARTUP` (default `true` in packaged app)
- `AUTO_UPDATE_CHECK_INTERVAL_MS` (default 30 minutes; minimum 60 seconds)
