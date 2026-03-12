# Gateway backend domain (producao)

Objetivo: criar um backend real para o gateway e ligar `gateway.messly.site` no Cloudflare sem apontar para Pages.

## 1) Subir o gateway

Este repositorio agora inclui `render.yaml` para criar o servico `messly-gateway` no Render.

Passos:

1. No Render, escolha **Blueprint** e conecte este repositorio.
2. Aplique o `render.yaml`.
3. Configure os env vars obrigatorios (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SECRET_KEY`, R2).
4. Deploy.

Ao terminar, o Render mostra um host publico do backend, por exemplo:

- `https://messly-gateway.onrender.com`

Esse e o seu dominio real de backend.

## 2) Configurar DNS no Cloudflare

No DNS da zona `messly.site`, configure:

- Type: `CNAME`
- Name: `gateway`
- Target: `messly-gateway.onrender.com` (ou o host real do seu provedor)
- Proxy status: `Proxied`
- TTL: `Auto`

Nao use `gateway -> messly.site`.

## 3) Confirmar no app

Frontend e desktop devem continuar com:

- `VITE_MESSLY_GATEWAY_URL=wss://gateway.messly.site/gateway`

Teste:

1. Abra `https://gateway.messly.site/` e confirme JSON `service: "messly-gateway"`.
2. Abra `https://gateway.messly.site/gateway` no browser e confirme retorno `426 upgrade_required`.
3. No app, valide que o WebSocket conecta em `wss://gateway.messly.site/gateway`.
