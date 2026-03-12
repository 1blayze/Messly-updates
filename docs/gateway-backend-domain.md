# Gateway backend domain (producao)

Objetivo: publicar o gateway do Messly no Google Cloud Run e expor `gateway.messly.site` via Cloudflare proxy.

## 1) Subir o servico no Google Cloud Run

Passos:

1. Build da imagem com o `Dockerfile` deste repositorio.
2. Publique a imagem no Artifact Registry ou Container Registry.
3. Deploy no Cloud Run com WebSocket habilitado.
4. Configure as envs obrigatorias do gateway.

Exemplo:

```bash
gcloud run deploy messly-gateway \
  --image us-central1-docker.pkg.dev/<project>/<repo>/messly-gateway:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080
```

Ao terminar, o Cloud Run fornece um host publico, por exemplo:

- `https://messly-gateway-abcde-uc.a.run.app`

Esse e o origin do gateway.

## 2) Configurar DNS no Cloudflare

No DNS da zona `messly.site`, configure:

- Type: `CNAME`
- Name: `gateway`
- Target: `<cloud-run-service>.a.run.app`
- Proxy status: `Proxied`
- TTL: `Auto`

Nao use `gateway -> messly.site`.

## 3) Confirmar no app

Frontend e desktop devem continuar com:

- `VITE_MESSLY_GATEWAY_URL=wss://gateway.messly.site/gateway`

Teste:

1. Abra `https://gateway.messly.site/healthz`.
2. Abra `https://gateway.messly.site/readyz`.
3. Abra `https://gateway.messly.site/gateway` no browser e confirme retorno `426 upgrade_required`.
4. No app, valide que o WebSocket conecta em `wss://gateway.messly.site/gateway`.
