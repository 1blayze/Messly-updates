import * as assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTurnstile } from "../verifyTurnstile";

test("verifyTurnstile fail-closed when token is missing", async () => {
  const result = await verifyTurnstile({
    token: "",
    secretKey: "secret",
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "captcha_missing");
});

test("verifyTurnstile fail-closed on invalid JSON response", async () => {
  const result = await verifyTurnstile({
    token: "token",
    secretKey: "secret",
    fetchImpl: async () =>
      new Response("not-json", {
        status: 200,
      }),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "captcha_response_invalid");
});

test("verifyTurnstile maps timeout-or-duplicate to captcha_expired", async () => {
  const result = await verifyTurnstile({
    token: "token",
    secretKey: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "captcha_expired");
});

test("verifyTurnstile returns success when Cloudflare siteverify succeeds", async () => {
  const result = await verifyTurnstile({
    token: "token",
    secretKey: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          "error-codes": [],
          hostname: "messly.local",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  });

  assert.equal(result.success, true);
  assert.equal(result.hostname, "messly.local");
});

test("verifyTurnstile fail-closed on timeout", async () => {
  const result = await verifyTurnstile({
    token: "token",
    secretKey: "secret",
    timeoutMs: 10,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "captcha_timeout");
});
