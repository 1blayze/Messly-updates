# Deploy do Messly no Cloudflare Pages

Este projeto fica pronto para deploy do app web no Cloudflare Pages com output em `dist`.

## 1) Pré-requisitos

- Repositório no GitHub
- Projeto Cloudflare Pages conectado ao repositório
- Domínio `app.messly.site` configurado no Cloudflare

## 2) Configuração do projeto no Pages

- Framework preset: `Vite` (ou `None`)
- Build command: `npm run build:pages`
- Build output directory: `dist`
- Root directory: `/` (raiz do repositório)

## 3) Variáveis de ambiente (Pages)

Cadastre no projeto do Cloudflare Pages:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` (ou `VITE_SUPABASE_ANON_KEY`, legado)
- `VITE_MESSLY_API_URL` = `https://api.messly.site`
- `VITE_MESSLY_GATEWAY_URL` = `wss://gateway.messly.site`
- `VITE_MESSLY_CDN_URL` = `https://cdn.messly.site`
- `VITE_MESSLY_ASSETS_URL` = `https://messly.site`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_SPOTIFY_CLIENT_ID` (se usar conexões Spotify)
- `VITE_SPOTIFY_REDIRECT_URI` = `https://app.messly.site/`

Opcional para acelerar install de dependências no ambiente de CI:

- `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1`

## 4) SPA fallback e headers

Já incluído no projeto:

- `public/_redirects`: fallback para `index.html`
- `public/_headers`: headers de segurança e cache

## 5) Publicação

1. Faça push para `main` no GitHub.
2. No Cloudflare Pages, habilite deploy automático da branch `main`.
3. Adicione domínio customizado `app.messly.site`.
4. Aguarde o deploy e valide:
   - login
   - registro
   - realtime
   - upload de mídia

## 6) Observações

- O desktop/Electron continua funcionando com a mesma base de código.
- A API deve estar publicada separadamente em `api.messly.site`.
- CDN/R2 deve estar ativo em `cdn.messly.site`.
