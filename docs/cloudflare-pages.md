# Deploy do Messly no Cloudflare Pages (messly.site)

Este projeto esta pronto para deploy do app web no Cloudflare Pages com output em `dist`.

## 1) Pre-requisitos

- Repositorio no GitHub
- Projeto Cloudflare Pages conectado ao repositorio
- Dominio `messly.site` configurado no Cloudflare

## 2) Configuracao do projeto no Pages

- Framework preset: `None` (ou `Vite`, se aparecer)
- Build command: `npm run build:pages`
- Build output directory: `dist`
- Root directory: `/` (raiz do repositorio)

## 3) Variaveis de ambiente (Pages)

Cadastre no projeto do Cloudflare Pages:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY` (ou `VITE_SUPABASE_ANON_KEY`, legado)
- `VITE_MESSLY_API_URL` = `https://messly.site`
- `VITE_MESSLY_AUTH_API_URL` = `https://messly.site`
- `VITE_MESSLY_GATEWAY_URL` = `wss://messly.site`
- `VITE_MESSLY_CDN_URL` = `https://cdn.messly.site`
- `VITE_MESSLY_ASSETS_URL` = `https://messly.site`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_SPOTIFY_CLIENT_ID` (se usar conexao Spotify)
- `VITE_SPOTIFY_REDIRECT_URI` = `https://messly.site/`

Opcional para acelerar install de dependencias no CI:

- `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1`

## 4) SPA fallback e headers

Ja incluido no projeto:

- `public/_redirects`: fallback para `index.html`
- `public/_headers`: headers de seguranca e cache

## 5) Publicacao

1. Faca push para `main` no GitHub.
2. No Cloudflare Pages, habilite deploy automatico da branch `main`.
3. Adicione dominio customizado `messly.site`.
4. Aguarde o deploy e valide:
   - login
   - cadastro
   - captcha
   - realtime
   - upload de midia

## 6) Observacoes

- O desktop/Electron continua funcionando com a mesma base de codigo.
- Para o app web, o dominio principal e `https://messly.site`.
- O CDN/R2 pode continuar em `https://cdn.messly.site`.
