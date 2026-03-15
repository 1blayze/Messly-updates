# Messly Gateway

Gateway realtime distribuido para `wss://gateway.messly.site/gateway`, preparado para Cloud Run com Redis obrigatorio.

## Arquitetura

- `server/src/bootstrap`: bootstrap do processo, HTTP/WS e lifecycle
- `server/src/config`: schema forte de ambiente
- `server/src/logging`: logger estruturado
- `server/src/metrics`: metricas e snapshot interno
- `server/src/protocol`: opcodes, payloads e validacao de frames
- `server/src/redis`: cliente Redis, rate limit e lease distribuido
- `server/src/sessions`: sessao resumivel e buffer de replay
- `server/src/presence`: presenca agregada por usuario/dispositivo
- `server/src/pubsub`: bus distribuido, roteamento e bridge de eventos do banco
- `server/src/ws`: registry local e typing local da instancia

## Endpoints

- `GET /livez`
- `GET /readyz`
- `GET /healthz`
- `GET /metrics`
- `WS /gateway`

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

## Verificacao

```bash
npx tsc --pretty false --noEmit -p server/tsconfig.server.json
```
