# Messly: Passo a Passo para Subir Atualizacao do Aplicativo

Este guia publica uma nova versao do app desktop (Windows) com auto-update.

## 1) Pre-requisitos

- Estar na branch `main`.
- Ter login no GitHub com permissao nos repos:
  - codigo: `1blayze/Messly`
  - updates: `1blayze/Messly-updates`
- Ter token no `.env.local` (um destes):
  - `GH_TOKEN`
  - `GITHUB_TOKEN`
  - `MESSLY_UPDATER_TOKEN`

Exemplo (`.env.local`):

```env
GH_TOKEN=seu_token_aqui
MESSLY_UPDATER_TOKEN=seu_token_aqui
```

## 2) Entrar na pasta do projeto

```powershell
cd C:\Users\marco\OneDrive\Documentos\Messly
```

## 3) Atualizar versao

Escolha a nova versao e rode:

```powershell
npm version 0.0.X --no-git-tag-version
```

Isso atualiza `package.json` e `package-lock.json`.

## 4) Publicar instalador + latest.yml

```powershell
npm run release:win
```

Esse comando:

- gera build de producao
- cria `release/messly-setup.exe`
- cria `release/latest.yml`
- envia os arquivos para `1blayze/Messly-updates` (release `v0.0.X`)

## 5) Validar artefatos locais

```powershell
npm run release:verify
```

Deve validar:

- `release/messly-setup.exe`
- `release/latest.yml`
- `release/win-unpacked/resources/app.asar`

## 6) Commit, tag e push do codigo

```powershell
git add .
git commit -m "chore: release 0.0.X"
git tag -a v0.0.X -m "v0.0.X"
git push origin main
git push origin v0.0.X
```

## 7) Confirmar no GitHub

### Repo de updates (`Messly-updates`)

Verifique se existe release `v0.0.X` com:

- `latest.yml`
- `messly-setup.exe`
- `messly-setup.exe.blockmap`

### Repo de codigo (`Messly`)

Verifique:

- commit no `main`
- tag `v0.0.X`

## 8) Testar no app instalado

1. Abrir app instalado em uma versao anterior.
2. Aguardar checagem de update (ou reiniciar o app).
3. Confirmar download e instalacao.
4. Confirmar que abriu na nova versao.

## Problemas comuns

### `Missing GitHub token for publish mode`

Falta token no ambiente. Configure `GH_TOKEN` ou `MESSLY_UPDATER_TOKEN` no `.env.local`.

### Update nao aparece no app

- Verifique se `latest.yml` da release esta correto.
- Feche e abra o app para forcar nova checagem.
- Confirme que o app instalado aponta para `1blayze/Messly-updates`.

### Erro de permissao ao publicar release

O token precisa permissao de `repo` para criar release e upload de assets.

