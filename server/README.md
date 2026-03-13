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
- `server/src/voice`: servidor de voz (estado da call, participantes, resume/rejoin)
- `server/src/sfu`: SFU baseado em mediasoup (publish/subscribe de audio, video e screen share)

## Endpoints

- `GET /livez`
- `GET /readyz`
- `GET /healthz`
- `GET /metrics`
- `WS /gateway`
- `WS /voice`

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
- `MESSLY_SFU_LISTEN_IP`
- `MESSLY_SFU_ANNOUNCED_IP` (opcional em dev local)
- `MESSLY_SFU_RTC_MIN_PORT`
- `MESSLY_SFU_RTC_MAX_PORT`
- `MESSLY_SFU_ENABLE_UDP`
- `MESSLY_SFU_ENABLE_TCP`
- `MESSLY_SFU_PREFER_UDP`
- `MESSLY_SFU_INITIAL_OUTGOING_BITRATE`
- `MESSLY_SFU_MAX_INCOMING_BITRATE`
- `MESSLY_VOICE_PARTICIPANT_RESUME_TTL_MS`
- `MESSLY_VOICE_EMPTY_CALL_TTL_MS`

## Verificacao

```bash
npx tsc --pretty false --noEmit -p server/tsconfig.server.json
```
