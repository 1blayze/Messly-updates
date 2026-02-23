const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;

export function isE2EEEnabled(): boolean {
  const raw = String(import.meta.env.VITE_CHAT_E2EE_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function generateConversationKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportConversationKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importConversationKey(base64: string): Promise<CryptoKey> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return crypto.subtle.importKey(
    "raw",
    bytes,
    {
      name: "AES-GCM",
      length: AES_KEY_LENGTH,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptMessage(key: CryptoKey, plainText: string): Promise<{ ivBase64: string; cipherTextBase64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plainText);

  const cipherBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    encoded,
  );

  const cipherBytes = new Uint8Array(cipherBuffer);

  return {
    ivBase64: btoa(String.fromCharCode(...iv)),
    cipherTextBase64: btoa(String.fromCharCode(...cipherBytes)),
  };
}

export async function decryptMessage(key: CryptoKey, ivBase64: string, cipherTextBase64: string): Promise<string> {
  const ivBinary = atob(ivBase64);
  const cipherBinary = atob(cipherTextBase64);

  const iv = new Uint8Array(ivBinary.length);
  for (let index = 0; index < ivBinary.length; index += 1) {
    iv[index] = ivBinary.charCodeAt(index);
  }

  const cipher = new Uint8Array(cipherBinary.length);
  for (let index = 0; index < cipherBinary.length; index += 1) {
    cipher[index] = cipherBinary.charCodeAt(index);
  }

  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    cipher,
  );

  return new TextDecoder().decode(plainBuffer);
}
