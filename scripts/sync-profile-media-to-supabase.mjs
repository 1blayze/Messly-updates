import fs from "node:fs";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

function parseEnvFile(path) {
  const content = fs.readFileSync(path, "utf8");
  const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx < 0) {
        return null;
      }
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
    .filter(Boolean);

  return Object.fromEntries(entries);
}

function requireEnv(env, key) {
  const value = String(env[key] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function objectExistsInSupabaseBucket(supabase, bucket, key) {
  const { error } = await supabase.storage.from(bucket).createSignedUrl(key, 60);
  if (!error) {
    return true;
  }
  const message = String(error.message ?? "").toLowerCase();
  const statusCode = String(error.statusCode ?? "");
  if (message.includes("not found") || statusCode === "404") {
    return false;
  }
  throw new Error(`Error checking Supabase object "${key}": ${error.message}`);
}

async function main() {
  const env = parseEnvFile(".env");

  const supabaseUrl = String(env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").trim();
  const supabaseServiceKey = String(env.SUPABASE_SECRET_KEY ?? "").trim();
  const supabaseBucket = String(env.VITE_MEDIA_BUCKET ?? env.VITE_R2_BUCKET ?? "messly-media").trim();

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env");
  }

  const r2Bucket = requireEnv(env, "R2_BUCKET");
  const r2Endpoint = requireEnv(env, "R2_ENDPOINT");
  const r2AccessKeyId = requireEnv(env, "R2_ACCESS_KEY_ID");
  const r2SecretAccessKey = requireEnv(env, "R2_SECRET_ACCESS_KEY");
  const r2Region = String(env.R2_REGION ?? "auto").trim() || "auto";
  const r2ForcePathStyle = String(env.R2_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() === "true";

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const r2 = new S3Client({
    region: r2Region,
    endpoint: r2Endpoint,
    forcePathStyle: r2ForcePathStyle,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("avatar_key,banner_key");

  if (usersError) {
    throw new Error(`Failed to load users media keys: ${usersError.message}`);
  }

  const keys = Array.from(
    new Set(
      (users ?? [])
        .flatMap((row) => [row.avatar_key, row.banner_key])
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  );

  let copied = 0;
  let alreadyPresent = 0;
  let skippedMissingInR2 = 0;
  let failed = 0;

  for (const key of keys) {
    try {
      const exists = await objectExistsInSupabaseBucket(supabase, supabaseBucket, key);
      if (exists) {
        alreadyPresent += 1;
        continue;
      }

      let head;
      try {
        head = await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
      } catch {
        skippedMissingInR2 += 1;
        continue;
      }

      const object = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
      if (!object.Body) {
        skippedMissingInR2 += 1;
        continue;
      }

      const bytes = await streamToBuffer(object.Body);
      const contentType = String(object.ContentType ?? head?.ContentType ?? "").trim() || undefined;

      const { error: uploadError } = await supabase.storage.from(supabaseBucket).upload(key, bytes, {
        upsert: true,
        contentType,
        cacheControl: "31536000",
      });

      if (uploadError) {
        failed += 1;
        console.error(`[FAIL] ${key}: ${uploadError.message}`);
        continue;
      }

      copied += 1;
      console.log(`[COPIED] ${key}`);
    } catch (error) {
      failed += 1;
      console.error(`[FAIL] ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("---- sync summary ----");
  console.log(`total keys: ${keys.length}`);
  console.log(`already present in Supabase: ${alreadyPresent}`);
  console.log(`copied from R2: ${copied}`);
  console.log(`missing in R2 (skipped): ${skippedMissingInR2}`);
  console.log(`failed: ${failed}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
