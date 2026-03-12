import "dotenv/config";
import { readGatewayEnv } from "./config/env";
import { createGatewayApplication } from "./bootstrap/gatewayApplication";

async function bootstrap(): Promise<void> {
  const env = readGatewayEnv();
  const application = await createGatewayApplication(env);

  const shutdown = async (signal: string) => {
    await application.shutdown(signal);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void bootstrap().catch((error) => {
  console.error("Failed to start gateway", error);
  process.exit(1);
});
