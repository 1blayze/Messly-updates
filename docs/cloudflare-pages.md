# Deploy do Messly no Cloudflare Pages (messly.site)

Este projeto esta pronto para deploy do app web no Cloudflare Pages com output em `dist`.

## 1) Pre-requisitos

- Repositorio no GitHub
- Projeto Cloudflare Pages conectado ao repositorio
- Dominio `messly.site` configurado no Cloudflare
- Gateway publicado separadamente no Google Cloud Run

## 2) Configuracao do projeto no Pages

- Framework preset: `None` (ou `Vite`, se aparecer)
- Build command: `npm run build:pages`
- Build output directory: `dist`
- Root directory: `/` (raiz do repositorio)

## 3) Variaveis de ambiente (Pages)

Cadastre no projeto do Cloudflare Pages:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_MESSLY_API_URL=https://gateway.messly.site`
- `VITE_MESSLY_AUTH_API_URL=https://gateway.messly.site`
- `VITE_MESSLY_GATEWAY_URL=wss://gateway.messly.site/gateway`
- `VITE_MESSLY_CDN_URL=https://cdn.messly.site`
- `VITE_MESSLY_ASSETS_URL=https://messly.site`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_SPOTIFY_CLIENT_ID`
- `VITE_SPOTIFY_REDIRECT_URI=https://messly.site/`

Opcional para acelerar install de dependencias no CI:

- `ELECTRON_SKIP_BINARY_DOWNLOAD=1`

## 3.1) Gateway WebSocket em subdominio dedicado (obrigatorio)

Nao publique o gateway em `wss://messly.site/gateway` quando o frontend estiver no Cloudflare Pages.
Com SPA fallback (`/* /index.html 200`), a rota `/gateway` pode ser capturada pelo app estatico e responder `200`, quebrando o handshake WebSocket.

Padrao recomendado:

- Frontend: `https://messly.site`
- Gateway: `wss://gateway.messly.site/gateway`

Configuracao DNS recomendada no Cloudflare:

- Type: `CNAME`
- Name: `gateway`
- Target: `<cloud-run-service>.a.run.app`
- Proxy status: `Proxied`

Importante:

- Nao aponte `gateway` para `messly.site`.
- O origin do backend deve ser o host do Cloud Run ou de um load balancer dedicado.

## 4) SPA fallback e headers

Ja incluido no projeto:

- `public/_redirects`: proxy canonico `/api/*`, `/auth/*` e `/media/*` para `gateway.messly.site`
- `public/_redirects`: fallback para `index.html`
- `public/_headers`: headers de seguranca e cache

## 5) Publicacao

1. Faca push para `main` no GitHub.
2. No Cloudflare Pages, habilite deploy automatico da branch `main`.
3. Adicione dominio customizado `messly.site`.
4. Configure (ou atualize) `gateway.messly.site` apontando para o Cloud Run.
5. Aguarde o deploy e valide login, cadastro, realtime e upload de midia.
