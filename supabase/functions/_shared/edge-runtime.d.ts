declare namespace Deno {
  namespace env {
    function get(key: string): string | undefined;
  }

  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

declare module "npm:zod@3.25.76" {
  export const z: any;
  export namespace z {
    type infer<T = unknown> = any;
  }
}

declare module "npm:jose@5.9.6" {
  export const createRemoteJWKSet: any;
  export const jwtVerify: any;
  export type JWTPayload = Record<string, unknown>;
}

declare module "npm:@supabase/supabase-js@2.98.0" {
  export const createClient: any;
  export type SupabaseClient = any;
}
