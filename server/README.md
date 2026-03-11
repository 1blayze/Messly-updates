# Messly Realtime Server

Arquitetura completa de realtime para Edge + Event Bus + Sharding.

## Estrutura

- `server/src/edge`: autenticação, WebSocket, controle de conexao e rate limiting
- `server/src/events`: event bus e contrato de eventos de dominio
- `server/src/fanout`: fanout e roteamento por shard
- `server/src/presence`: presence efemero em redis/ram
- `server/src/typing`: indicator typing efemero
- `server/src/realtime`: core em tempo real e integração com gateway
- `server/src/subscriptions`: gerenciador de subscriptions por topico
- `server/src/auth`: validacao de JWT do Supabase
- `server/src/signaling`: ponte de eventos WebRTC
- `server/src/infra`: env, redis client e observabilidade

## Observacoes de operacao

- Em modo local (sem `MESSLY_REDIS_URL`), o bootstrap usa `InMemoryEventBus` e `InMemoryPresenceStore`.
- Em producao, configure Redis para:
  - presence efemero (`presence snapshots`)
  - fanout de assinaturas
  - sincronizacao entre shards via pub/sub

## Verificacao rapida

```bash
npx tsc --pretty false --noEmit -p server/tsconfig.server.json
```

## Variaveis

- `MESSLY_GATEWAY_PORT`
- `MESSLY_GATEWAY_SHARD_COUNT`
- `MESSLY_GATEWAY_SHARD_INDEX` (opcional)
- `MESSLY_GATEWAY_EVENT_CHANNEL`
- `MESSLY_GATEWAY_METRICS_PATH`
- `MESSLY_REDIS_URL`
- `MESSLY_PRESENCE_TTL_SECONDS`
- `MESSLY_TYPING_TTL_MS`

## Runtime

- O cliente renderer deve apontar `VITE_MESSLY_GATEWAY_URL` para o endpoint WebSocket do gateway, ex: `ws://localhost:8788/gateway`.
- Em producao com Cloudflare Pages, use subdominio dedicado para evitar fallback SPA no mesmo host do frontend: `wss://gateway.messly.site/gateway`.
