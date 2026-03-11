import { E2EEError } from "./errors";

interface NodeBufferLike {
  from(input: string | ArrayLike<number> | ArrayBuffer, encoding?: "base64"): {
    toString(encoding: "base64"): string;
    readonly length: number;
    [index: number]: number;
  };
}

export function getWebCrypto(): Crypto {
  const runtime = globalThis.crypto;
  if (runtime?.subtle && typeof runtime.getRandomValues === "function") {
    return runtime;
  }
  throw new E2EEError("unsupported_runtime", "Web Crypto runtime is not available.");
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new E2EEError("invalid_argument", "randomBytes length must be a positive integer.", {
      details: {
        length,
      },
    });
  }
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
}

export function randomId(prefix = "id"): string {
  const runtime = globalThis.crypto;
  if (runtime && typeof runtime.randomUUID === "function") {
    return `${prefix}_${runtime.randomUUID()}`;
  }
  const random = randomBytes(16);
  let hex = "";
  for (let index = 0; index < random.length; index += 1) {
    hex += random[index].toString(16).padStart(2, "0");
  }
  return `${prefix}_${hex}`;
}

export function getNodeBuffer(): NodeBufferLike | null {
  const maybe = globalThis as unknown as { Buffer?: NodeBufferLike };
  if (maybe.Buffer && typeof maybe.Buffer.from === "function") {
    return maybe.Buffer;
  }
  return null;
}
