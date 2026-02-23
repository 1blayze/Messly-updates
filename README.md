# Messly

## Configuracao Firebase

Copie `.env.example` para `.env` e configure as variaveis:

```bash
cp .env.example .env
```

Veja `CONFIGURACAO_FIREBASE.md` para instrucoes detalhadas de ativacao do Realtime Database.

## Variaveis de ambiente (R2 privado)

Obrigatorias no backend (Electron main):

```env
R2_BUCKET=messly-media
R2_ENDPOINT=https://<accountId>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

Opcional:

```env
R2_REGION=auto
R2_FORCE_PATH_STYLE=true
```

No modo privado, avatar/banner/anexos sao carregados por Signed URL gerada no backend.
