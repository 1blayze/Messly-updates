## Edge Function Secrets

### Required
- `ALLOWED_ORIGINS` (fallback from `CORS_ALLOWED_ORIGINS`)
- `CORS_ALLOW_CREDENTIALS`
- `ALLOW_ELECTRON_ORIGIN`
- `R2_ENDPOINT`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_REGION`

### Optional (feature-specific)
- `VITE_SUPABASE_URL` (only if you want custom override; platform already injects `SUPABASE_URL`)
- `VITE_SUPABASE_PUBLISHABLE_KEY` (only if you want custom override; platform already injects `SUPABASE_ANON_KEY`)
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `IPINFO_TOKEN`
- `IPAPI_KEY`

### Safe apply command
```powershell
.\scripts\supabase\set-edge-secrets.ps1 -ProjectRef <project-ref> -EnvPath .env -IncludeOptional
```
