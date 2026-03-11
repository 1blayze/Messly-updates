import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLogin, handleLogout } from "./login";
import { handleResendVerification, handleSignup } from "./signup";
import { handleVerifyEmail } from "./verifyEmail";
import { AuthHttpError, readJsonBody, resolveCorsHeaders, writeEmpty, writeJson } from "./http";
import {
  readAuthRequestContext,
  type AuthDependencies,
  type LoginRequestBody,
  type ResendVerificationRequestBody,
  type SignupRequestBody,
  type VerifyEmailRequestBody,
} from "./types";

function buildNotFoundBody() {
  return {
    error: {
      code: "NOT_FOUND",
      message: "Auth endpoint not found.",
    },
  };
}

export class AuthRouter {
  constructor(private readonly deps: AuthDependencies) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://messly.local");
    if (!url.pathname.startsWith("/auth")) {
      return false;
    }

    const context = readAuthRequestContext(request);
    try {
      const corsHeaders = resolveCorsHeaders(context.origin, this.deps.env);

      if (request.method === "OPTIONS") {
        writeEmpty(response, 204, corsHeaders);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/auth/signup") {
        const body = await readJsonBody<SignupRequestBody>(request);
        const payload = await handleSignup(this.deps, context, body);
        writeJson(response, 202, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/auth/resend-verification") {
        const body = await readJsonBody<ResendVerificationRequestBody>(request);
        const payload = await handleResendVerification(this.deps, context, body);
        writeJson(response, 202, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/auth/verify-email") {
        const body = await readJsonBody<VerifyEmailRequestBody>(request);
        const payload = await handleVerifyEmail(this.deps, context, body);
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const body = await readJsonBody<LoginRequestBody>(request);
        const payload = await handleLogin(this.deps, context, body);
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const payload = await handleLogout(this.deps, context);
        writeJson(response, 200, payload, corsHeaders);
        return true;
      }

      writeJson(response, 404, buildNotFoundBody(), corsHeaders);
      return true;
    } catch (error) {
      const httpError =
        error instanceof AuthHttpError
          ? error
          : new AuthHttpError(
              500,
              "AUTH_INTERNAL_ERROR",
              error instanceof Error ? error.message : "Unexpected auth server error.",
            );

      this.deps.logger?.warn("Auth request failed", {
        path: url.pathname,
        method: request.method,
        code: httpError.code,
        status: httpError.status,
        message: httpError.message,
      });

      const corsHeaders = (() => {
        try {
          return resolveCorsHeaders(context.origin, this.deps.env);
        } catch {
          return {
            vary: "Origin",
          };
        }
      })();

      writeJson(
        response,
        httpError.status,
        {
          error: {
            code: httpError.code,
            message: httpError.message,
            details: httpError.details,
          },
        },
        corsHeaders,
        httpError.headers,
      );
      return true;
    }
  }
}
