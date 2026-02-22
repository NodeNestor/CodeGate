/**
 * All regex patterns for simple pattern-based guardrails.
 *
 * LiteLLM-style patterns definition: each pattern includes the regex,
 * replacement generator, optional validator, and metadata.
 */

import type { PatternDef } from "./types.js";
import { shortHash, hmac } from "./shared.js";

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
  replacementGenerator: (original: string) => {
    const h = shortHash(original);
    const atIdx = original.indexOf("@");
    const domain = atIdx >= 0 ? original.slice(atIdx + 1) : "example.com";
    const domainParts = domain.split(".");
    const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : "com";
    return `user_${h}@anon.${tld}`;
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
    const h = hmac(original);
    let hIdx = 0;
    return original.replace(/\d/g, () => {
      const digit = parseInt(h[hIdx % h.length], 16) % 10;
      hIdx++;
      return String(digit);
    });
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
    const h = shortHash(original, 6);
    return `[SSN-REDACTED-${h}]`;
  },
  validator: (match: string) => {
    // Basic SSN validation: not all zeros in any group
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
    // Visa
    /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    // Mastercard
    /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    // Amex
    /\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b/g,
    // Discover
    /\b6(?:011|5\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ],
  replacementGenerator: (original: string) => {
    const h = shortHash(original, 6);
    const digits = original.replace(/[\s-]/g, "");
    let type = "CARD";
    if (digits.startsWith("4")) type = "VISA";
    else if (/^5[1-5]/.test(digits)) type = "MC";
    else if (/^3[47]/.test(digits)) type = "AMEX";
    else if (digits.startsWith("6")) type = "DISC";
    return `[CARD-${type}-${h}]`;
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
    const h = shortHash(original, 6);
    return `[IBAN-REDACTED-${h}]`;
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
    // US: 9 digits
    /\b[0-9]{9}\b/g,
    // UK: 9 digits (same format, context needed)
    // DE: C followed by 8 alphanumeric
    /\bC[A-Z0-9]{8}\b/g,
    // FR: 2 digits + 2 letters + 5 digits
    /\b\d{2}[A-Z]{2}\d{5}\b/g,
    // NL: 2 letters + 6 digits + 1 letter
    /\b[A-Z]{2}\d{6}[A-Z]\b/g,
    // CA: 2 letters + 6 digits
    /\b[A-Z]{2}\d{6}\b/g,
  ],
  contextPattern: /(?:passport|travel\s+document|document\s+number|passport\s+no)/gi,
  replacementGenerator: (original: string) => {
    const h = shortHash(original, 6);
    return `[PASSPORT-REDACTED-${h}]`;
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
    // IPv4
    /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    // IPv6 (simplified - common formats)
    /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    /\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b/g,
    /\b::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g,
  ],
  replacementGenerator: (original: string) => {
    // Check if IPv6
    if (original.includes(":")) {
      const h = hmac(original);
      return `fd00::${h.slice(0, 4)}:${h.slice(4, 8)}`;
    }
    // IPv4
    const h = hmac(original);
    const o1 = (parseInt(h.slice(0, 2), 16) % 223) + 1;
    const o2 = parseInt(h.slice(2, 4), 16) % 256;
    const o3 = parseInt(h.slice(4, 6), 16) % 256;
    const o4 = (parseInt(h.slice(6, 8), 16) % 254) + 1;
    return `${o1}.${o2}.${o3}.${o4}`;
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
    const h = shortHash(original, 6);
    return `[ADDRESS-REDACTED-${h}]`;
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
    // AWS access key ID
    /\b(AKIA[0-9A-Z]{16})\b/g,
    // AWS secret key (40-char base64-ish near "aws" or "secret" context)
    /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_?key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  ],
  replacementGenerator: (original: string) => {
    const h = shortHash(original, 8);
    if (original.startsWith("AKIA")) {
      return `AKIA-REDACTED-${h}`;
    }
    return `[AWS-SECRET-${h}]`;
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
    const h = shortHash(original, 8);
    return `[JWT-REDACTED-${h}]`;
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
  replacementGenerator: (_original: string) => {
    return `[PRIVATE-KEY-REDACTED]`;
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
    return original.replace(
      /\/\/([^:]+):([^@]+)@/,
      `//[redacted-${shortHash(original)}]@`
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
