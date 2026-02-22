/**
 * All regex patterns for simple pattern-based guardrails.
 *
 * Stateless deterministic encryption - replacements embed encrypted tokens
 * in a consistent format: [<CATEGORY>-<encrypted-token>]
 *
 * Deanonymization extracts the token and decrypts it - no DB lookups needed.
 */

import type { PatternDef } from "./types.js";
import { shortHash, hmac, encryptForToken } from "./shared.js";

// Short fake-name pools for realistic email local parts
const EMAIL_FIRST = [
  "alex", "jordan", "casey", "taylor", "morgan", "riley", "quinn", "avery",
  "dakota", "skyler", "jamie", "parker", "rowan", "finley", "sage", "emery",
];
const EMAIL_LAST = [
  "morgan", "lee", "rivera", "chen", "bailey", "brooks", "foster", "hayes",
  "kim", "patel", "cruz", "diaz", "ellis", "grant", "harper", "huang",
];

// ─── PII Patterns ────────────────────────────────────────────────────────────

const emailPattern: PatternDef = {
  id: "email",
  name: "Email Addresses",
  description: "Detect and anonymize email addresses",
  category: "pii",
  icon: "Mail",
  color: "text-blue-400 bg-blue-600/10",
  priority: 10,
  patterns: [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g],
  validator: (match: string) => {
    // Skip already-anonymized emails
    if (/@anon\.com$/i.test(match)) return false;
    if (/\[email-/i.test(match)) return false;
    return true;
  },
  replacementGenerator: (original: string) => {
    // Generate a realistic-looking fake email (reverse-map handles deanonymization)
    const h = hmac(original);
    const first = EMAIL_FIRST[parseInt(h.slice(0, 4), 16) % EMAIL_FIRST.length];
    const last = EMAIL_LAST[parseInt(h.slice(4, 8), 16) % EMAIL_LAST.length];
    const num = parseInt(h.slice(8, 10), 16) % 100;
    return `${first}.${last}${num}@anon.com`;
  },
};

const phonePattern: PatternDef = {
  id: "phone",
  name: "Phone Numbers",
  description: "Detect US and international phone number formats",
  category: "pii",
  icon: "Phone",
  color: "text-cyan-400 bg-cyan-600/10",
  priority: 20,
  patterns: [
    /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "phone");
    // Generate a fake phone number format with token
    const h = hmac(original);
    const area = (parseInt(h.slice(0, 2), 16) % 800) + 200;
    const exchange = (parseInt(h.slice(2, 4), 16) % 800) + 100;
    const line = (parseInt(h.slice(4, 8), 16) % 9000) + 1000;
    return `${area}-${exchange}-${line}-${token.slice(0, 8)}`;
  },
};

const ssnPattern: PatternDef = {
  id: "ssn",
  name: "Social Security Numbers",
  description: "Detect SSN formats (XXX-XX-XXXX)",
  category: "pii",
  icon: "CreditCard",
  color: "text-red-400 bg-red-600/10",
  priority: 5,
  patterns: [
    /\b\d{3}-\d{2}-\d{4}\b/g,
    /\b(?!000|666|9\d{2})\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "ssn");
    return `[SSN-${token.slice(0, 12)}]`;
  },
  validator: (match: string) => {
    const digits = match.replace(/-/g, "");
    if (digits.length !== 9) return false;
    const area = digits.slice(0, 3);
    const group = digits.slice(3, 5);
    const serial = digits.slice(5);
    return area !== "000" && area !== "666" && !area.startsWith("9") &&
           group !== "00" && serial !== "0000";
  },
};

const creditCardPattern: PatternDef = {
  id: "credit_card",
  name: "Credit Cards",
  description: "Detect Visa, Mastercard, Amex, and Discover card numbers",
  category: "financial",
  icon: "CreditCard",
  color: "text-amber-400 bg-amber-600/10",
  priority: 5,
  patterns: [
    /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    /\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b/g,
    /\b6(?:011|5\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "card");
    const digits = original.replace(/[\s-]/g, "");
    let type = "CARD";
    if (digits.startsWith("4")) type = "VISA";
    else if (/^5[1-5]/.test(digits)) type = "MC";
    else if (/^3[47]/.test(digits)) type = "AMEX";
    else if (digits.startsWith("6")) type = "DISC";
    return `[${type}-${token.slice(0, 12)}]`;
  },
};

const ibanPattern: PatternDef = {
  id: "iban",
  name: "Bank Account Numbers",
  description: "Detect IBAN format bank account numbers",
  category: "financial",
  icon: "Landmark",
  color: "text-emerald-400 bg-emerald-600/10",
  priority: 15,
  patterns: [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "iban");
    return `[IBAN-${token.slice(0, 12)}]`;
  },
};

const passportPattern: PatternDef = {
  id: "passport",
  name: "Passport Numbers",
  description: "Detect passport numbers from multiple countries",
  category: "pii",
  icon: "BookOpen",
  color: "text-indigo-400 bg-indigo-600/10",
  priority: 25,
  patterns: [
    /\b[0-9]{9}\b/g,
    /\bC[A-Z0-9]{8}\b/g,
    /\b\d{2}[A-Z]{2}\d{5}\b/g,
    /\b[A-Z]{2}\d{6}[A-Z]\b/g,
    /\b[A-Z]{2}\d{6}\b/g,
  ],
  contextPattern: /(?:passport|travel\s+document|document\s+number|passport\s+no)/gi,
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "passport");
    return `[PASSPORT-${token.slice(0, 12)}]`;
  },
};

const ipAddressPattern: PatternDef = {
  id: "ip_address",
  name: "IP Addresses",
  description: "Detect and anonymize IPv4 and IPv6 addresses",
  category: "network",
  icon: "Globe",
  color: "text-purple-400 bg-purple-600/10",
  priority: 30,
  patterns: [
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    /\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b/g,
    /\b::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "ip");
    if (original.includes(":")) {
      return `[IPv6-${token.slice(0, 12)}]`;
    }
    // Generate a fake IP for display
    const h = hmac(original);
    const o1 = (parseInt(h.slice(0, 2), 16) % 223) + 1;
    const o2 = parseInt(h.slice(2, 4), 16) % 256;
    const o3 = parseInt(h.slice(4, 6), 16) % 256;
    const o4 = (parseInt(h.slice(6, 8), 16) % 254) + 1;
    return `[IP-${o1}.${o2}.${o3}.${o4}-${token.slice(0, 6)}]`;
  },
};

const streetAddressPattern: PatternDef = {
  id: "street_address",
  name: "Street Addresses",
  description: "Detect physical street addresses",
  category: "pii",
  icon: "MapPin",
  color: "text-rose-400 bg-rose-600/10",
  priority: 35,
  patterns: [
    /\b\d{1,6}\s+[A-Za-z0-9][\w\s.'-]*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Terrace|Ter|Highway|Hwy|Parkway|Pkwy|Trail|Trl)\b\.?/gi,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "address");
    return `[ADDR-${token}]`;
  },
};

// ─── Credential Patterns ─────────────────────────────────────────────────────

const awsKeysPattern: PatternDef = {
  id: "aws_keys",
  name: "AWS Credentials",
  description: "Detect AWS access keys and secret keys",
  category: "credentials",
  icon: "Cloud",
  color: "text-orange-400 bg-orange-600/10",
  priority: 3,
  patterns: [
    /\b(AKIA[0-9A-Z]{16})\b/g,
    /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "aws");
    if (original.startsWith("AKIA")) {
      return `[AKIA-${token.slice(0, 12)}]`;
    }
    return `[AWS-SECRET-${token.slice(0, 12)}]`;
  },
};

const jwtPattern: PatternDef = {
  id: "jwt",
  name: "JWT Tokens",
  description: "Detect JSON Web Tokens",
  category: "credentials",
  icon: "KeyRound",
  color: "text-yellow-400 bg-yellow-600/10",
  priority: 8,
  patterns: [
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "jwt");
    return `[JWT-${token.slice(0, 12)}]`;
  },
};

const privateKeyPattern: PatternDef = {
  id: "private_key",
  name: "Private Keys",
  description: "Detect PEM-format private key blocks",
  category: "credentials",
  icon: "FileKey",
  color: "text-red-400 bg-red-600/10",
  priority: 2,
  patterns: [
    /-----BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+|PGP\s+)?PRIVATE KEY-----/g,
  ],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "key");
    return `[PRIVATE-KEY-${token.slice(0, 12)}]`;
  },
};

const urlAuthPattern: PatternDef = {
  id: "url_auth",
  name: "URL Auth",
  description: "Strip credentials from URLs with embedded authentication",
  category: "credentials",
  icon: "Link2",
  color: "text-yellow-400 bg-yellow-600/10",
  priority: 12,
  patterns: [/https?:\/\/[^:\s]+:[^@\s]+@[^\s]+/g],
  replacementGenerator: (original: string) => {
    const token = encryptForToken(original, "url");
    return original.replace(
      /\/\/([^:]+):([^@]+)@/,
      `//[redacted-${token.slice(0, 8)}]@`
    );
  },
};

// ─── Export all pattern definitions ──────────────────────────────────────────

export const ALL_PATTERN_DEFS: PatternDef[] = [
  // Credentials (highest priority - run first)
  privateKeyPattern,
  awsKeysPattern,
  ssnPattern,
  creditCardPattern,
  jwtPattern,
  emailPattern,
  urlAuthPattern,
  ibanPattern,
  phonePattern,
  passportPattern,
  ipAddressPattern,
  streetAddressPattern,
];
