# Messly Gateway Server Example

Exemplo de gateway WebSocket central para o blueprint novo do Messly.

## O que ele cobre

- `HELLO`, `IDENTIFY`, `RESUME`, `HEARTBEAT`, `HEARTBEAT_ACK`, `PING`, `PONG`
- fanout por assinatura de `conversation`, `user`, `friends`, `notifications`
- validação de JWT do Supabase em `IDENTIFY` e `RESUME`
- `PRESENCE_UPDATE`, `SPOTIFY_UPDATE`, `TYPING_START`, `TYPING_STOP`
- bridge de `messages` e `friend_requests` do Supabase Realtime para eventos do gateway

## Variáveis de ambiente

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
MESSLY_GATEWAY_PORT=8788
```

## Executar

```bash
npm run dev:gateway-example
```

## Endpoint

```text
ws://localhost:8788/gateway
```

## Observações de produção

- Para 100k+ conexões, substitua o fanout em memória por Redis, NATS ou Kafka.
- Use múltiplos nós atrás de load balancer com sticky sessions ou sessão resumível em Redis.
- `typing` deve continuar efêmero em memória.
- `messages` continuam sendo persistidas por API ou RPC; o gateway só entrega eventos.
