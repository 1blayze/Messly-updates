# Supabase Deploy Alert (2026-03-18)

## Critical inconsistency detected

- `.env` / `.temp` project ref: `udpxebdaxauvtinnfcxu`
- Current authenticated CLI account cannot access this project (`403 insufficient privileges`).

Because of this mismatch, remote migration apply was **intentionally blocked** to avoid changing the wrong environment.

## Required manual fix

1. Authenticate with an account that has access to `udpxebdaxauvtinnfcxu`:
   - `npx supabase login --token <ACCESS_TOKEN_WITH_PROJECT_PERMISSIONS>`
2. Link the intended project:
   - `npx supabase link --project-ref udpxebdaxauvtinnfcxu`
3. Validate migration history consistency (local vs remote):
   - `npx supabase migration list`
4. If history is inconsistent because old local migrations were deleted, repair before push:
   - `npx supabase migration fetch`
   - or restore missing files under `supabase/migrations/`
5. Apply migration:
   - `npx supabase db push`
6. Run validation:
   - `npx supabase db query --linked --file supabase/migrations/20260318_security_refactor.sql`
   - If already applied, run dedicated checks by querying `pg_policies`, grants and index presence.

## Rollback

- `npx supabase db query --linked --file supabase/migrations/rollback_security.sql`
