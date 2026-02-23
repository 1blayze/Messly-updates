function getRequiredEnv(name) {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name) {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || undefined;
}

function parseBoolean(value, defaultValue) {
  if (value == null) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function loadBackendEnv() {
  const R2_BUCKET = getRequiredEnv("R2_BUCKET");
  const R2_ENDPOINT = getRequiredEnv("R2_ENDPOINT");
  const R2_ACCESS_KEY_ID = getRequiredEnv("R2_ACCESS_KEY_ID");
  const R2_SECRET_ACCESS_KEY = getRequiredEnv("R2_SECRET_ACCESS_KEY");

  const R2_REGION = getOptionalEnv("R2_REGION") || "auto";
  const R2_FORCE_PATH_STYLE = parseBoolean(getOptionalEnv("R2_FORCE_PATH_STYLE"), true);
  const SUPABASE_URL = getOptionalEnv("SUPABASE_URL") || getOptionalEnv("VITE_SUPABASE_URL");
  const SUPABASE_SECRET_KEY = getOptionalEnv("SUPABASE_SECRET_KEY");
  const SUPABASE_MEDIA_BUCKET = getOptionalEnv("VITE_MEDIA_BUCKET") || getOptionalEnv("VITE_R2_BUCKET") || "messly-media";

  return {
    R2_BUCKET,
    R2_ENDPOINT,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_REGION,
    R2_FORCE_PATH_STYLE,
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    SUPABASE_MEDIA_BUCKET,
  };
}

const backendEnv = loadBackendEnv();

module.exports = {
  backendEnv,
  loadBackendEnv,
};
