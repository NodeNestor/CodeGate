import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const LEGACY_KEY_FILE = path.join(DATA_DIR, ".master-key");
const ACCOUNT_KEY_FILE = path.join(DATA_DIR, ".account-key");
const GUARDRAIL_KEY_FILE = path.join(DATA_DIR, ".guardrail-key");

let cachedAccountKey: Buffer | null = null;
let cachedGuardrailKey: Buffer | null = null;

// ─── Key loading helpers ─────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function deriveKeyFromEnv(envValue: string, salt: string): Buffer {
  return crypto.scryptSync(envValue, Buffer.from(salt, "utf8"), 32);
}

function readKeyFile(filePath: string): Buffer {
  const hex = fs.readFileSync(filePath, "utf8").trim();
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      `Invalid key length in ${filePath}: expected 32 bytes, got ${key.length}`
    );
  }
  return key;
}

function generateAndSaveKey(filePath: string): Buffer {
  ensureDataDir();
  const key = crypto.randomBytes(32);
  fs.writeFileSync(filePath, key.toString("hex"), { mode: 0o600 });
  return key;
}

// ─── Migration: .master-key → .account-key ──────────────────────────────────

function migrateFromLegacyKey(): void {
  if (
    fs.existsSync(LEGACY_KEY_FILE) &&
    !fs.existsSync(ACCOUNT_KEY_FILE)
  ) {
    const hex = fs.readFileSync(LEGACY_KEY_FILE, "utf8").trim();
    fs.writeFileSync(ACCOUNT_KEY_FILE, hex, { mode: 0o600 });
    console.log(
      "[encryption] Migrated .master-key → .account-key"
    );
  }
}

// Run migration on module load
migrateFromLegacyKey();

// ─── Account key (AES-256-GCM for API keys/tokens in the DB) ────────────────

/**
 * Returns a 32-byte account key for AES-256-GCM encryption of stored secrets.
 * Priority:
 *   1. ACCOUNT_KEY env var (derived via scrypt)
 *   2. MASTER_KEY env var (backward compat, derived via scrypt)
 *   3. {DATA_DIR}/.account-key file
 *   4. Generate random 32 bytes and persist to file
 */
export function getAccountKey(): Buffer {
  if (cachedAccountKey) return cachedAccountKey;

  // Check ACCOUNT_KEY env first
  const envAccountKey = process.env.ACCOUNT_KEY;
  if (envAccountKey && envAccountKey !== "auto" && envAccountKey.length > 0) {
    cachedAccountKey = deriveKeyFromEnv(envAccountKey, "claude-proxy-account-key-salt");
    return cachedAccountKey;
  }

  // Backward compat: MASTER_KEY env var
  const envMasterKey = process.env.MASTER_KEY;
  if (envMasterKey && envMasterKey !== "auto" && envMasterKey.length > 0) {
    cachedAccountKey = deriveKeyFromEnv(envMasterKey, "claude-proxy-master-key-salt");
    return cachedAccountKey;
  }

  // Try reading from file
  if (fs.existsSync(ACCOUNT_KEY_FILE)) {
    cachedAccountKey = readKeyFile(ACCOUNT_KEY_FILE);
    return cachedAccountKey;
  }

  // Generate and save
  cachedAccountKey = generateAndSaveKey(ACCOUNT_KEY_FILE);
  return cachedAccountKey;
}

/** Backward-compat alias */
export function getMasterKey(): Buffer {
  return getAccountKey();
}

// ─── Guardrail key (AES-256-CTR for deterministic anonymization) ─────────────

/**
 * Returns a 32-byte guardrail key for deterministic encryption in anonymization.
 * Priority:
 *   1. GUARDRAIL_KEY env var (derived via scrypt)
 *   2. {DATA_DIR}/.guardrail-key file
 *   3. Generate random 32 bytes and persist to file
 */
export function getGuardrailKey(): Buffer {
  if (cachedGuardrailKey) return cachedGuardrailKey;

  const envKey = process.env.GUARDRAIL_KEY;
  if (envKey && envKey !== "auto" && envKey.length > 0) {
    cachedGuardrailKey = deriveKeyFromEnv(envKey, "claude-proxy-guardrail-key-salt");
    return cachedGuardrailKey;
  }

  if (fs.existsSync(GUARDRAIL_KEY_FILE)) {
    cachedGuardrailKey = readKeyFile(GUARDRAIL_KEY_FILE);
    return cachedGuardrailKey;
  }

  cachedGuardrailKey = generateAndSaveKey(GUARDRAIL_KEY_FILE);
  return cachedGuardrailKey;
}

// ─── Fingerprinting ──────────────────────────────────────────────────────────

/** First 8 hex chars of SHA-256 of the key — safe to expose publicly. */
export function getKeyFingerprint(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Which source a key was loaded from. */
export function getKeySource(
  envVarNames: string[],
  filePath: string
): "env" | "file" | "generated" {
  for (const name of envVarNames) {
    const val = process.env[name];
    if (val && val !== "auto" && val.length > 0) return "env";
  }
  if (fs.existsSync(filePath)) return "file";
  return "generated";
}

export function getAccountKeySource(): "env" | "file" | "generated" {
  return getKeySource(["ACCOUNT_KEY", "MASTER_KEY"], ACCOUNT_KEY_FILE);
}

export function getGuardrailKeySource(): "env" | "file" | "generated" {
  return getKeySource(["GUARDRAIL_KEY"], GUARDRAIL_KEY_FILE);
}

// ─── Key rotation ────────────────────────────────────────────────────────────

export function rotateAccountKey(): Buffer {
  cachedAccountKey = null;
  const newKey = generateAndSaveKey(ACCOUNT_KEY_FILE);
  cachedAccountKey = newKey;
  return newKey;
}

export function rotateGuardrailKey(): Buffer {
  cachedGuardrailKey = null;
  const newKey = generateAndSaveKey(GUARDRAIL_KEY_FILE);
  cachedGuardrailKey = newKey;
  return newKey;
}

// ─── AES-256-GCM encrypt / decrypt (account data) ───────────────────────────

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns base64(iv[16] + ciphertext + authTag[16]).
 */
export function encrypt(plaintext: string): string {
  const key = getAccountKey();
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
  const key = getAccountKey();
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

/**
 * Decrypt with a specific key (for re-encryption during key rotation).
 */
export function decryptWithKey(encrypted: string, key: Buffer): string {
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

/**
 * Encrypt with a specific key (for re-encryption during key rotation).
 */
export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

/**
 * Wraps decrypt() in a try/catch — returns null on failure.
 */
export function tryDecrypt(encrypted: string): string | null {
  try {
    return decrypt(encrypted);
  } catch {
    return null;
  }
}
