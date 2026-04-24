// AES-GCM key encryption using browser's native Web Crypto API
// No external dependencies required.

const PBKDF2_ITERATIONS = 200_000;
const SALT_LEN = 16;
const IV_LEN = 12;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptData(data: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(data),
  );
  // Pack: salt (16) + iv (12) + ciphertext → base64
  const buf = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  buf.set(salt, 0);
  buf.set(iv, SALT_LEN);
  buf.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return btoa(String.fromCharCode(...buf));
}

export async function decryptData(encoded: string, password: string): Promise<string> {
  const buf = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const salt = buf.slice(0, SALT_LEN);
  const iv = buf.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = buf.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(password, salt);
  const dec = new TextDecoder();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return dec.decode(plain);
}

// Returns true if the stored value looks like an encrypted blob (base64, not JSON)
export function isEncrypted(raw: string): boolean {
  try {
    JSON.parse(raw);
    return false; // plaintext JSON — old format
  } catch {
    return true; // not JSON → encrypted
  }
}
