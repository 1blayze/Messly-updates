# Messly: Publicacao de Atualizacao (Arquitetura Shared Runtime)

Este fluxo publica os artefatos separados do desktop:

- `MesslySetup.exe` (bootstrap)
- `messly-runtime-win32-x64.zip` (runtime Electron)
- `messly-app-win32-x64.zip` (aplicacao Messly)
- manifests de update (`runtime-manifest.json` e `app-manifest.json`)

## 1) Pre-requisitos

- Branch `main` atualizada.
- Permissao no repositório de updates.
- Token configurado em `.env.local`:
  - `GH_TOKEN` ou
  - `GITHUB_TOKEN` ou
  - `MESSLY_UPDATER_TOKEN`

Exemplo:

```env
GH_TOKEN=seu_token
```

## 2) Entrar no projeto

```powershell
cd C:\Users\marco\OneDrive\Documentos\Messly
```

## 3) Atualizar versao do app

```powershell
npm version 0.0.X --no-git-tag-version
```

## 4) Gerar artefatos locais

```powershell
npm run package:win
```

Artefatos esperados em `release/shared-runtime/artifacts/`:

- `MesslySetup.exe`
- `messly-runtime-win32-x64.zip`
- `messly-app-win32-x64.zip`
- `runtime-manifest.json`
- `app-manifest.json`
- `size-report.json`

## 5) Validar artefatos

```powershell
npm run release:verify
```

## 6) Publicar release (opcional automatizado)

```powershell
npm run release:win
```

Por padrão, publica em:

- owner: `1blayze`
- repo: `Messly-updates`
- tag: `v<versao-do-package.json>`

Variáveis úteis:

- `MESSLY_RELEASE_OWNER`
- `MESSLY_RELEASE_REPO`
- `MESSLY_RELEASE_TAG`
- `MESSLY_RELEASE_NAME`
- `MESSLY_RELEASE_BASE_URL`

## 7) Commit, tag e push do código

```powershell
git add .
git commit -m "chore: release 0.0.X"
git tag -a v0.0.X -m "v0.0.X"
git push origin main
git push origin v0.0.X
```

## 8) Verificacao final

- Confirmar assets da release no GitHub:
  - `MesslySetup.exe`
  - `messly-runtime-win32-x64.zip`
  - `messly-app-win32-x64.zip`
  - `runtime-manifest.json`
  - `app-manifest.json`
- Instalar com `MesslySetup.exe` em maquina limpa.
- Confirmar criacao dos caminhos:
  - `%LOCALAPPDATA%\Messly\runtime`
  - `%LOCALAPPDATA%\Messly\app`
- Confirmar que atualizacoes de runtime e app ocorrem de forma independente.
