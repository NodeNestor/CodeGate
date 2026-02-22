import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const KEY_FILE = path.join(DATA_DIR, ".master-key");

let cachedKey: Buffer | null = null;

/**
 * Returns a 32-byte master key for AES-256-GCM encryption.
 * Priority:
 *   1. MASTER_KEY env var (derived via scrypt)
 *   2. {DATA_DIR}/.master-key file
 *   3. Generate random 32 bytes and persist to file
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.MASTER_KEY;
  if (envKey) {
    // Derive a 32-byte key from the passphrase using scrypt
    const salt = Buffer.from("claude-proxy-master-key-salt", "utf8");
    cachedKey = crypto.scryptSync(envKey, salt, 32);
    return cachedKey;
  }

  // Try reading from file
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
    cachedKey = Buffer.from(hex, "hex");
    if (cachedKey.length !== 32) {
      throw new Error(
        `Invalid master key length in ${KEY_FILE}: expected 32 bytes, got ${cachedKey.length}`
      );
    }
    return cachedKey;
  }

  // Generate and save
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, cachedKey.toString("hex"), { mode: 0o600 });
  return cachedKey;
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns base64(iv[16] + ciphertext + authTag[16]).
 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Decrypts a string produced by encrypt().
 * Expects base64(iv[16] + ciphertext + authTag[16]).
 */
export function decrypt(encrypted: string): string {
  const key = getMasterKey();
  const combined = Buffer.from(encrypted, "base64");

  if (combined.length < 33) {
    throw new Error("Encrypted data too short");
  }

  const iv = combined.subarray(0, 16);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(16, combined.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
