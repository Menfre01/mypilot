import { open, stat } from 'node:fs/promises';
import type { TranscriptEntry, TranscriptBlock, TokenUsage } from '../../shared/protocol.js';

const TAIL_BYTES = 65536;
const THINKING_MAX_CHARS = 1000;
const TEXT_MAX_CHARS = 10000;
const TOOL_RESULT_MAX_CHARS = 4000;

type JsonEntry = Record<string, unknown>;

// ── File reading ──

async function readTailBlock(filePath: string, maxBytes: number): Promise<{ text: string; fileSize: number }> {
  const decoder = new TextDecoder();
  const handle = await open(filePath, 'r');
  try {
    const st = await handle.stat();
    if (st.size <= maxBytes) {
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await handle.read(buf, 0, st.size, 0);
      return { text: decoder.decode(buf.subarray(0, bytesRead)), fileSize: st.size };
    }
    const start = Math.max(0, st.size - maxBytes);
    const toRead = st.size - start;
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, start);
    let text = decoder.decode(buf.subarray(0, bytesRead));
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) {
      text = text.slice(firstNewline + 1);
    }
    return { text, fileSize: st.size };
  } finally {
    await handle.close();
  }
}

export function parseEntries(lines: string[]): JsonEntry[] {
  const entries: JsonEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ── Cache ──

const TRANSCRIPT_CACHE_MAX = 50;
const transcriptCache = new Map<string, { size: number; entries: JsonEntry[] }>();

export function clearTranscriptCache(): void {
  transcriptCache.clear();
}

async function loadEntries(filePath: string, bypassCache = false): Promise<{ entries: JsonEntry[]; fileSize: number }> {
  try {
    if (!bypassCache) {
      const { size } = await stat(filePath);
      const cached = transcriptCache.get(filePath);
      if (cached && cached.size === size) return { entries: cached.entries, fileSize: size };
    }

    const { text, fileSize } = await readTailBlock(filePath, TAIL_BYTES);
    if (!text) return { entries: [], fileSize };

    const entries = parseEntries(text.split('\n'));

    try {
      // Delete first to update iteration order (Map.set on existing key doesn't change position)
      transcriptCache.delete(filePath);
      transcriptCache.set(filePath, { size: fileSize, entries });
      if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
        const first = transcriptCache.keys().next().value;
        if (first !== undefined) transcriptCache.delete(first);
      }
    } catch { /* ignore */ }

    return { entries, fileSize };
  } catch {
    return { entries: [], fileSize: 0 };
  }
}

// ── Block extraction ──

function toNumber(val: unknown, fallback: number): number {
  return typeof val === 'number' ? val : fallback;
}

export function parseTimestamp(raw: unknown): number {
  return typeof raw === 'string'
    ? new Date(raw).getTime()
    : typeof raw === 'number'
      ? raw
      : Date.now();
}

function getContentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content as Array<Record<string, unknown>>;
}

function extractModel(entry: JsonEntry, message: Record<string, unknown>): string | undefined {
  const topModel = typeof entry.model === 'string' ? entry.model : '';
  const msgModel = typeof message.model === 'string' ? message.model : '';
  const combined = msgModel || topModel;
  return combined || undefined;
}

function extractUsage(message: Record<string, unknown>): TokenUsage | undefined {
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input_tokens: toNumber(usage.input_tokens, 0),
    output_tokens: toNumber(usage.output_tokens, 0),
    cache_read_input_tokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
    cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
  };
}

function extractThinkingBlocks(content: Array<Record<string, unknown>>): string | undefined {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      parts.push(block.thinking);
    }
  }
  if (!parts.length) return undefined;
  return parts.join('\n').slice(0, THINKING_MAX_CHARS);
}

function extractTextBlocks(content: Array<Record<string, unknown>>): string | undefined {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    }
  }
  if (!parts.length) return undefined;
  return parts.join('\n').slice(0, TEXT_MAX_CHARS);
}

function extractToolUseBlocks(content: Array<Record<string, unknown>>): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    blocks.push({
      type: 'tool_use',
      id: typeof block.id === 'string' ? block.id : undefined,
      name: typeof block.name === 'string' ? block.name : undefined,
      input: typeof block.input === 'object' && block.input !== null
        ? block.input as Record<string, unknown>
        : undefined,
    });
  }
  return blocks;
}

function extractToolResultContent(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.slice(0, TOOL_RESULT_MAX_CHARS);
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    if (!parts.length) return undefined;
    return parts.join('\n').slice(0, TOOL_RESULT_MAX_CHARS);
  }
  return undefined;
}

function extractToolResultBlocks(content: Array<Record<string, unknown>>): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const trimmed = extractToolResultContent(block.content);
    if (!trimmed) continue;
    blocks.push({
      type: 'tool_result',
      tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
      content: trimmed,
      isError: block.isError === true,
    });
  }
  return blocks;
}

// ── Entry classification ──

export interface ParsedEntry {
  blocks: TranscriptBlock[];
  model?: string;
  usage?: TokenUsage;
}

export function classifyEntry(entry: JsonEntry): ParsedEntry | null {
  const type = entry.type as string | undefined;
  if (type !== 'assistant' && type !== 'user') return null;

  const message = entry.message;
  if (typeof message !== 'object' || message === null) return null;

  const msg = message as Record<string, unknown>;
  const content = getContentBlocks(msg);
  if (!content.length) return null;

  const blocks: TranscriptBlock[] = [];
  let model: string | undefined;
  let usage: TokenUsage | undefined;

  if (type === 'assistant') {
    model = extractModel(entry, msg);
    usage = extractUsage(msg);

    const thinking = extractThinkingBlocks(content);
    if (thinking) {
      blocks.push({ type: 'thinking', thinking });
    }

    const text = extractTextBlocks(content);
    if (text) {
      blocks.push({ type: 'text', text });
    }

    blocks.push(...extractToolUseBlocks(content));
  } else {
    // user type
    const text = extractTextBlocks(content);
    if (text) {
      blocks.push({ type: 'text', text });
    }

    blocks.push(...extractToolResultBlocks(content));
  }

  if (!blocks.length) return null;

  return { blocks, model, usage };
}

// ── Public API ──

export interface TranscriptReadResult {
  entries: TranscriptEntry[];
  fileSize: number;
  lineCount: number;
}

/**
 * Read and classify all transcript entries from a file.
 * Returns structured TranscriptEntry objects suitable for the client.
 */
export async function readTranscript(
  transcriptPath: string,
  lastReadIndex?: number,
): Promise<TranscriptReadResult> {
  const { entries: rawEntries, fileSize } = await loadEntries(transcriptPath);
  const results: TranscriptEntry[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    // Skip already-processed entries
    if (lastReadIndex !== undefined && i < lastReadIndex) continue;

    const raw = rawEntries[i];
    const parsed = classifyEntry(raw);
    if (!parsed) continue;

    const timestamp = parseTimestamp(raw.timestamp);

    results.push({
      index: i,
      type: raw.type as 'assistant' | 'user',
      timestamp,
      model: parsed.model,
      usage: parsed.usage,
      blocks: parsed.blocks,
    });
  }

  return { entries: results, fileSize, lineCount: rawEntries.length };
}

/**
 * Read a specific tool_use entry and its result from a transcript.
 * Returns the assistant entry and optionally the user (tool_result) entry.
 */
export async function readToolEntry(
  transcriptPath: string,
  toolUseId: string,
): Promise<{ assistant: TranscriptEntry | null; result: TranscriptEntry | null }> {
  const { entries: rawEntries } = await loadEntries(transcriptPath, true);

  let assistant: TranscriptEntry | null = null;
  let result: TranscriptEntry | null = null;

  for (let i = rawEntries.length - 1; i >= 0; i--) {
    const raw = rawEntries[i];
    const parsed = classifyEntry(raw);
    if (!parsed) continue;

    // Looking for the assistant entry containing this tool_use
    if (!assistant && raw.type === 'assistant') {
      const hasMatch = parsed.blocks.some(b => b.type === 'tool_use' && b.id === toolUseId);
      if (hasMatch) {
        assistant = {
          index: i,
          type: 'assistant',
          timestamp: parseTimestamp(raw.timestamp),
          model: parsed.model,
          usage: parsed.usage,
          blocks: parsed.blocks,
        };
      }
    }

    // Looking for the user entry containing this result
    if (!result && raw.type === 'user') {
      const hasMatch = parsed.blocks.some(b =>
        b.type === 'tool_result' && b.tool_use_id === toolUseId,
      );
      if (hasMatch) {
        result = {
          index: i,
          type: 'user',
          timestamp: parseTimestamp(raw.timestamp),
          blocks: parsed.blocks,
        };
      }
    }

    if (assistant && result) break;
  }

  return { assistant, result };
}
