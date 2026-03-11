function toUint8Array(input: Blob | File | ArrayBuffer | Uint8Array): Promise<Uint8Array> | Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  return input.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export async function sha256Hex(input: Blob | File | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = await toUint8Array(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("SubtleCrypto indisponivel para calcular SHA-256.");
  }

  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashFile(file: File | Blob): Promise<string> {
  return sha256Hex(file);
}
