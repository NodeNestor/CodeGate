/**
 * Fine-tune Export Module
 *
 * Captures request+response conversation pairs (including streaming)
 * into a JSONL file for fine-tuning use cases. Messages are normalized to
 * OpenAI format: [{role, content}] with text content only.
 *
 * By default, only the system prompt + last user message + assistant response
 * are stored per entry ("last-turn-only"). This avoids massive duplication
 * since each request in a coding session repeats the full 200k context.
 * Set finetune_full_context=true to store the complete conversation history.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { getSetting } from "./db.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FINETUNE_FILE = "finetune-export.jsonl";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FinetuneMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FinetuneEntry {
  conversation_id: string;
  turn_index: number;
  messages: FinetuneMessage[];
  model: string;
  provider: string;
  timestamp: string;
  tokens: { input: number; output: number };
  latency_ms: number;
}

export interface FinetuneInfo {
  enabled: boolean;
  full_context: boolean;
  file_exists: boolean;
  file_size_bytes: number;
  entry_count: number;
  file_path: string;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function isFinetuneEnabled(): boolean {
  return getSetting("finetune_logging") === "true";
}

// ─── Message extraction ─────────────────────────────────────────────────────

/**
 * Normalize messages from either Anthropic or OpenAI request format
 * into a flat [{role, content}] array. Only text content is kept.
 */
export function extractMessagesFromRequest(
  bodyJson: Record<string, unknown>,
  format: "anthropic" | "openai"
): FinetuneMessage[] {
  const result: FinetuneMessage[] = [];

  if (format === "anthropic") {
    // Anthropic: { system?, messages: [{role, content}] }
    if (typeof bodyJson.system === "string" && bodyJson.system) {
      result.push({ role: "system", content: bodyJson.system });
    } else if (Array.isArray(bodyJson.system)) {
      // system can be an array of content blocks
      const text = (bodyJson.system as any[])
        .filter((b: any) => b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
      if (text) result.push({ role: "system", content: text });
    }

    const messages = bodyJson.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const role = msg.role === "assistant" ? "assistant" : "user";
        const content = extractTextContent(msg.content);
        if (content) result.push({ role, content });
      }
    }
  } else {
    // OpenAI: { messages: [{role, content}] }
    const messages = bodyJson.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const role =
          msg.role === "system"
            ? "system"
            : msg.role === "assistant"
              ? "assistant"
              : "user";
        const content = extractTextContent(msg.content);
        if (content) result.push({ role, content });
      }
    }
  }

  return result;
}

/**
 * Extract plain text from message content (string or content blocks array).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: any) =>
          (block.type === "text" && typeof block.text === "string") ||
          (typeof block.type === "undefined" && typeof block.text === "string")
      )
      .map((block: any) => block.text)
      .join("\n");
  }
  return "";
}

// ─── SSE parsing ────────────────────────────────────────────────────────────

/**
 * Parse Anthropic SSE text and extract assistant response text.
 * Collects `content_block_delta` events where `delta.type === "text_delta"`.
 */
export function extractTextFromAnthropicSSE(sseText: string): string {
  const chunks: string[] = [];
  const lines = sseText.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      if (
        parsed.type === "content_block_delta" &&
        parsed.delta?.type === "text_delta" &&
        typeof parsed.delta.text === "string"
      ) {
        chunks.push(parsed.delta.text);
      }
    } catch {
      // skip malformed lines
    }
  }

  return chunks.join("");
}

/**
 * Parse OpenAI SSE text and extract assistant response text.
 * Collects `choices[0].delta.content` from each data line.
 */
export function extractTextFromOpenAISSE(sseText: string): string {
  const chunks: string[] = [];
  const lines = sseText.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        chunks.push(content);
      }
    } catch {
      // skip malformed lines
    }
  }

  return chunks.join("");
}

/**
 * Extract assistant text from a non-streaming response body.
 */
export function extractTextFromResponse(
  body: string,
  format: "anthropic" | "openai"
): string {
  try {
    const parsed = JSON.parse(body);

    if (format === "anthropic") {
      // Anthropic: { content: [{type: "text", text: "..."}] }
      if (Array.isArray(parsed.content)) {
        return parsed.content
          .filter((b: any) => b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n");
      }
    } else {
      // OpenAI: { choices: [{message: {content: "..."}}] }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
    }
  } catch {
    // unparseable
  }
  return "";
}

// ─── Conversation tracking ──────────────────────────────────────────────────

/**
 * Derive a stable conversation ID from the messages. Within a multi-turn
 * conversation, every request repeats the full history — so the system prompt
 * + first user message are always identical. We hash those to get a short,
 * stable ID that links all turns of the same conversation.
 */
export function deriveConversationId(messages: FinetuneMessage[]): string {
  let fingerprint = "";
  for (const msg of messages) {
    if (msg.role === "system") {
      fingerprint += "system:" + msg.content + "\n";
    }
    if (msg.role === "user") {
      fingerprint += "user:" + msg.content;
      break; // only need the first user message
    }
  }
  return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
}

/**
 * Count user turns in the conversation (= number of user messages).
 */
export function deriveTurnIndex(messages: FinetuneMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

// ─── Message trimming ───────────────────────────────────────────────────────

/**
 * Trim a conversation to just: system prompt (if any) + last user message +
 * assistant response. For fine-tuning, individual turns are what you need —
 * storing the full 200k context each time would be wasteful duplication.
 */
export function trimToLastTurn(messages: FinetuneMessage[]): FinetuneMessage[] {
  const result: FinetuneMessage[] = [];

  // Keep system message if present
  if (messages.length > 0 && messages[0].role === "system") {
    result.push(messages[0]);
  }

  // Find the last user message and everything after it (the assistant response)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx >= 0) {
    // Include last user message + any following assistant messages
    for (let i = lastUserIdx; i < messages.length; i++) {
      result.push(messages[i]);
    }
  }

  return result;
}

// ─── File I/O ───────────────────────────────────────────────────────────────

export function getFinetuneFilePath(): string {
  return path.join(DATA_DIR, FINETUNE_FILE);
}

/**
 * Append a single JSONL entry to the finetune export file.
 * Automatically trims to last turn unless finetune_full_context is enabled.
 */
export function writeFinetuneEntry(entry: FinetuneEntry): void {
  const fullContext = getSetting("finetune_full_context") === "true";
  const trimmedEntry = fullContext
    ? entry
    : { ...entry, messages: trimToLastTurn(entry.messages) };

  const filePath = getFinetuneFilePath();
  const line = JSON.stringify(trimmedEntry) + "\n";

  setImmediate(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      console.error("[finetune] Failed to write entry:", err);
    }
  });
}

/**
 * Return file stats for the finetune export.
 */
export function getFinetuneInfo(): FinetuneInfo {
  const filePath = getFinetuneFilePath();
  const enabled = isFinetuneEnabled();
  const fullContext = getSetting("finetune_full_context") === "true";

  if (!fs.existsSync(filePath)) {
    return {
      enabled,
      full_context: fullContext,
      file_exists: false,
      file_size_bytes: 0,
      entry_count: 0,
      file_path: filePath,
    };
  }

  const stats = fs.statSync(filePath);
  let entryCount = 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    entryCount = content.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // if we can't read, just report 0
  }

  return {
    enabled,
    full_context: fullContext,
    file_exists: true,
    file_size_bytes: stats.size,
    entry_count: entryCount,
    file_path: filePath,
  };
}

/**
 * Gzip the finetune export file contents for download.
 */
export function gzipFinetuneFile(): Buffer | null {
  const filePath = getFinetuneFilePath();
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  return zlib.gzipSync(raw, { level: 9 });
}

/**
 * Delete the finetune export file.
 */
export function clearFinetuneData(): boolean {
  const filePath = getFinetuneFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
