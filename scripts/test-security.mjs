import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const outDir = resolve(projectRoot, ".temp/server-test-cjs");

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
  "ES2022",
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
  "server/src/auth/crypto.ts",
  "server/src/auth/http.ts",
  "server/src/auth/signup.ts",
  "server/src/auth/types.ts",
  "server/src/security/disposableEmailDomains.ts",
  "server/src/security/evaluateRegistrationRisk.ts",
  "server/src/security/verifyTurnstile.ts",
  "server/src/security/__tests__/verifyTurnstile.test.ts",
  "server/src/security/__tests__/registrationRiskFlow.test.ts",
  "server/src/infra/env.ts",
  "server/src/infra/logger.ts",
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

const compiledTestsDir = join(outDir, "security", "__tests__");
const compiledTests = readdirSync(compiledTestsDir)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => join(compiledTestsDir, file));

runOrThrow("node", ["--test", "--test-isolation=none", ...compiledTests]);
