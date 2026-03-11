import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { InMemoryRateLimiter } from "../edge/rateLimiter";
import { readGatewayEnv } from "../infra/env";
import { createLogger } from "../infra/logger";
import { AuthSessionManager } from "../sessions/sessionManager";
import { MediaService } from "../media/service";

export async function runCleanupOrphanFilesJob(): Promise<void> {
  const env = readGatewayEnv();
  const logger = createLogger("media-cleanup");

  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios para cleanup de midia.");
  }

  const adminSupabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const mediaService = new MediaService({
    adminSupabase,
    sessionManager: new AuthSessionManager(adminSupabase, logger),
    rateLimiter: new InMemoryRateLimiter(),
    env,
    logger,
  });

  const result = await mediaService.cleanupOrphanFiles();
  logger.info("Cleanup de arquivos orfaos concluido", {
    scanned: result.scanned,
    deleted: result.deleted.length,
    retained: result.retained.length,
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void runCleanupOrphanFilesJob().catch((error) => {
    console.error("cleanupOrphanFiles failed", error);
    process.exit(1);
  });
}
