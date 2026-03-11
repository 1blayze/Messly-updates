import { assertOrThrow, E2EEError } from "./errors";
import { getNodeBuffer } from "./runtime";

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function utf8ToBytes(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}

export function bytesToUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  const nodeBuffer = getNodeBuffer();
  if (nodeBuffer) {
    return nodeBuffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64Raw: string, options?: { expectedLength?: number; label?: string }): Uint8Array {
  const base64 = String(base64Raw ?? "").trim();
  const label = options?.label ?? "base64";
  assertOrThrow(base64.length > 0, "invalid_base64", `${label} cannot be empty.`);
  assertOrThrow(BASE64_PATTERN.test(base64), "invalid_base64", `${label} is not valid base64.`);

  const nodeBuffer = getNodeBuffer();
  let bytes: Uint8Array;
  if (nodeBuffer) {
    const nodeValue = nodeBuffer.from(base64, "base64");
    bytes = new Uint8Array(nodeValue.length);
    for (let index = 0; index < nodeValue.length; index += 1) {
      bytes[index] = nodeValue[index];
    }
  } else {
    let binary: string;
    try {
      binary = atob(base64);
    } catch (error) {
      throw new E2EEError("invalid_base64", `${label} is not valid base64.`, {
        cause: error,
      });
    }
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  }

  if (Number.isInteger(options?.expectedLength) && options?.expectedLength !== undefined) {
    assertOrThrow(
      bytes.length === options.expectedLength,
      "invalid_payload",
      `${label} length is invalid.`,
      {
        expectedLength: options.expectedLength,
        actualLength: bytes.length,
      },
    );
  }
  return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export function u32ToBytes(value: number): Uint8Array {
  assertOrThrow(Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff, "invalid_argument", "u32 value is out of range.");
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value, false);
  return out;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out.buffer;
}

export function toCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}
