import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const outDir = resolve(projectRoot, ".temp/e2ee-test-cjs");

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(outDir, {
  recursive: true,
  force: true,
});

const tscEntry = resolve(projectRoot, "node_modules/typescript/bin/tsc");
runOrThrow("node", [
  tscEntry,
  "--target",
  "ES2022",
  "--lib",
  "ES2022,DOM",
  "--module",
  "commonjs",
  "--moduleResolution",
  "node",
  "--strict",
  "true",
  "--skipLibCheck",
  "true",
  "--outDir",
  outDir,
  "src/services/crypto/e2ee/algorithms.ts",
  "src/services/crypto/e2ee/encoding.ts",
  "src/services/crypto/e2ee/errors.ts",
  "src/services/crypto/e2ee/identity.ts",
  "src/services/crypto/e2ee/kdf.ts",
  "src/services/crypto/e2ee/message.ts",
  "src/services/crypto/e2ee/prekeys.ts",
  "src/services/crypto/e2ee/protocol.ts",
  "src/services/crypto/e2ee/runtime.ts",
  "src/services/crypto/e2ee/serialization.ts",
  "src/services/crypto/e2ee/session.ts",
  "src/services/crypto/e2ee/storage.ts",
  "src/services/crypto/e2ee/types.ts",
  "src/services/crypto/e2ee/__tests__/e2eeProtocol.test.ts",
]);

writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      type: "commonjs",
    },
    null,
    2,
  ),
  "utf8",
);

const testsDir = join(outDir, "__tests__");
const testFiles = readdirSync(testsDir)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => join(testsDir, file));

runOrThrow("node", ["--test", "--test-isolation=none", ...testFiles]);
