# Configuração do Firebase

## Credenciais Configuradas

As credenciais do Firebase foram atualizadas no arquivo `.env.example`:

```env
VITE_FIREBASE_API_KEY=AIzaSyBY7kJpgqswvGZxHHHkBhSn-DTmMvchBI8
VITE_FIREBASE_AUTH_DOMAIN=mey-br.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=mey-br
VITE_FIREBASE_STORAGE_BUCKET=mey-br.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=887911396257
VITE_FIREBASE_APP_ID=1:887911396257:web:1884cef094bfac918c51e0
VITE_FIREBASE_DATABASE_URL=https://mey-br-default-rtdb.firebaseio.com
VITE_FIREBASE_PRESENCE_ENABLED=true
```

## Passos para Ativar

1. **Copie o arquivo `.env.example` para `.env`:**
   ```bash
   cp .env.example .env
   ```

2. **Configure o Realtime Database no Firebase Console:**
   - Acesse: https://console.firebase.google.com/project/mey-br/database
   - Clique em "Criar banco de dados"
   - Escolha o modo "Bloqueado" (mais seguro) ou "Teste" (para desenvolvimento)
   - Clique em "Ativar"

3. **Reinicie o servidor de desenvolvimento:**
   ```bash
   npm run dev
   ```

## Estrutura do Banco de Dados

O sistema de presença criará automaticamente a seguinte estrutura:

```
users/{userId}/preferredPresence
  ├── state: "online" | "idle" | "dnd" | "offline"
  └── updatedAt: timestamp

presence/{userId}/{deviceId}
  ├── state: "online" | "idle" | "dnd" | "offline"
  ├── platform: "desktop" | "mobile" | "browser"
  ├── lastActive: timestamp
  └── updatedAt: timestamp
```

## Regras de Segurança (Realtime Database)

Adicione estas regras no Firebase Console para permitir que usuários salvem apenas seus próprios dados:

1. Acesse: https://console.firebase.google.com/project/mey-br/database/mey-br-default-rtdb/rules
2. Substitua as regras existentes por:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid == $uid",
        ".write": "auth != null && auth.uid == $uid"
      }
    },
    "presence": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth != null && auth.uid == $uid",
        "$deviceId": {
          ".read": "auth != null",
          ".write": "auth != null && auth.uid == $uid"
        }
      }
    }
  }
}
```

3. Clique em **"Publicar"**

### Modo de Desenvolvimento (Temporário)

Se estiver com problemas de permissão durante o desenvolvimento, pode usar regras abertas temporariamente (⚠️ **NÃO use em produção**):

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```


## Verificação

Após configurar, abra o console do navegador (F12) e você verá:

```
[Presence] start() chamado, firebasePresenceEnabled: true, firebaseUid: xxx
[Presence] Inicializando presence para xxx, estado inicial: online
[Presence] Salvando estado preferido no Firebase: idle para user xxx
[Presence] Estado preferido salvo com sucesso: idle
```

## ⚠️ IMPORTANTE: Configuração das Regras de Segurança

Se você está vendo o erro `permission_denied` no console, **você PRECISA** configurar as regras do Realtime Database:

### Passo a passo rápido:

1. Acesse diretamente: https://console.firebase.google.com/project/mey-br/database/mey-br-default-rtdb/rules
2. **Apague** todo o conteúdo atual das regras
3. **Cole** exatamente isto:

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

4. Clique no botão **"Publicar"** (canto superior direito)
5. Aguarde 10-30 segundos
6. **Recarregue a página do app** (F5)

### Verificação:
Após publicar as regras e recarregar, você NÃO deve mais ver:
```
@firebase/database: FIREBASE WARNING: set at /presence/... failed: permission_denied
```

Se ainda aparecer, verifique se:
- Clicou em "Publicar" (não basta apenas editar)
- Aguardou alguns segundos antes de recarregar
- Está logado no app (as regras exigem autenticação)

### Regras mais restritivas (produção):

Depois que funcionar, você pode usar regras mais seguras:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid == $uid",
        ".write": "auth != null && auth.uid == $uid"
      }
    },
    "presence": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth != null && auth.uid == $uid",
        "$deviceId": {
          ".read": "auth != null",
          ".write": "auth != null && auth.uid == $uid"
        }
      }
    }
  }
}
```


[Presence] start() chamado, firebasePresenceEnabled: true, firebaseUid: xxx
[Presence] Inicializando presence para xxx, estado inicial: online
[Presence] Salvando estado preferido no Firebase: idle para user xxx
[Presence] Estado preferido salvo com sucesso: idle
