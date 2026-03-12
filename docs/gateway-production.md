# Gateway production architecture

## Resumo da arquitetura

- Entrada publica: Cloudflare DNS/proxy em `gateway.messly.site`
- Runtime inicial: Google Cloud Run
- Coordenacao distribuida: Redis obrigatorio
- Estado global: sessao resumivel, presence e bus em Redis
- Estado local: apenas conexoes websocket da instancia

## O que saiu do Render

- `render.yaml`
- referencias a `onrender.com`
- documentacao de Blueprint/Render
- suposicoes de single-instance com fallback em memoria para estado global

## Ciclo de conexao

1. Cliente abre `wss://gateway.messly.site/gateway`
2. Servidor responde `HELLO` com heartbeat, timeout e janela de resume
3. Cliente envia `IDENTIFY` ou `RESUME`
4. Servidor autentica token, registra sessao e entrega `READY` ou `RESUMED`
5. Cliente envia `HEARTBEAT`
6. Servidor responde `HEARTBEAT_ACK` e encerra conexoes zumbis se o timeout expirar

## Como o resume funciona

- `IDENTIFY` gera `sessionId` e `resumeToken`
- cada `DISPATCH` entregue para a sessao recebe sequence e entra no buffer Redis
- no reconnect o cliente envia `RESUME` com `sessionId`, `resumeToken` e `seq`
- se o buffer ainda cobre o `seq`, o gateway responde `RESUMED` e faz replay dos eventos faltantes
- se a sessao expirou ou houve gap no buffer, o gateway responde `INVALID_SESSION`

## Presenca distribuida

- cada sessao/dispositivo tem um registro proprio em Redis
- a presenca agregada do usuario e calculada a partir das sessoes ativas
- desconectar uma conexao nao derruba o usuario se outro device ainda estiver online
- atualizacoes de presence e spotify sao publicadas no bus e entregues entre instancias

## Variaveis obrigatorias

- `NODE_ENV`
- `PORT`
- `MESSLY_GATEWAY_PUBLIC_URL`
- `MESSLY_REDIS_URL`
- `MESSLY_ALLOWED_ORIGINS`
- `MESSLY_HEARTBEAT_INTERVAL_MS`
- `MESSLY_CLIENT_TIMEOUT_MS`
- `MESSLY_RESUME_TTL_SECONDS`
- `MESSLY_SESSION_BUFFER_SIZE`
- `MESSLY_LOG_LEVEL`
- `MESSLY_METRICS_ENABLED`
- `MESSLY_DRAIN_TIMEOUT_MS`
- `MESSLY_MAX_PAYLOAD_BYTES`
- `MESSLY_RATE_LIMIT_ENABLED`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `MESSLY_CDN_URL`

## Deploy no Cloud Run

1. Build da imagem com `docker build -t messly-gateway .`
2. Publique no Artifact Registry
3. Deploy com `gcloud run deploy`
4. Configure as envs obrigatorias
5. Aponte `gateway.messly.site` no Cloudflare para o host do Cloud Run
6. Valide `/livez`, `/readyz`, `/healthz` e o upgrade em `/gateway`

## Proximos passos para escala maior

- separar edge gateway e workers de fan-out
- introduzir roteamento por shard de usuario/room
- mover bridge do banco para workers dedicados
- exportar metricas para Cloud Monitoring / OpenTelemetry
- migrar de Cloud Run para GKE sem reescrever o protocolo
