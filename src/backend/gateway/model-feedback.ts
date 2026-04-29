import { open, stat } from 'node:fs/promises';
import type { ModelFeedback, TokenUsage } from '../../shared/protocol.js';

const TAIL_BYTES = 65536;
const THINKING_MAX_CHARS = 300;
const TEXT_MAX_CHARS = 500;
const TOOL_RESULT_MAX_CHARS = 1000;

// Escalating retry delays for when transcript data hasn't landed on disk yet.
// macOS APFS journaling can delay flushes past 80 ms under load.
const TRANSCRIPT_RETRY_DELAYS_MS = [50, 150, 300];
const TRANSCRIPT_RETRY_MAX = TRANSCRIPT_RETRY_DELAYS_MS.length;

function toNumber(val: unknown, fallback: number): number {
  return typeof val === 'number' ? val : fallback;
}

async function readTailBlock(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; fileSize: number }> {
  const decoder = new TextDecoder();
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size <= maxBytes) {
      const buf = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buf, 0, stat.size, 0);
      return { text: decoder.decode(buf.subarray(0, bytesRead)), fileSize: stat.size };
    }
    const start = Math.max(0, stat.size - maxBytes);
    const toRead = stat.size - start;
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(buf, 0, toRead, start);
    let text = decoder.decode(buf.subarray(0, bytesRead));
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) {
      text = text.slice(firstNewline + 1);
    }
    return { text, fileSize: stat.size };
  } finally {
    await handle.close();
  }
}

interface AssistantMatch {
  model: string;
  usage: Record<string, unknown>;
  thinking: string;
  text: string;
}

type JsonEntry = Record<string, unknown>;

function parseEntries(lines: string[]): JsonEntry[] {
  const entries: JsonEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return entries;
}

function getModel(entry: JsonEntry, message: Record<string, unknown>): string {
  const topModel = typeof entry.model === 'string' ? entry.model : '';
  const msgModel = typeof message.model === 'string' ? message.model : '';
  return msgModel || topModel || 'unknown';
}

function extractBlockContent(
  content: Array<Record<string, unknown>>,
  blockType: string,
  maxChars: number,
): string {
  for (const block of content) {
    if (block.type !== blockType) continue;
    const raw = typeof block[blockType] === 'string' ? (block[blockType] as string) : '';
    if (raw) return raw.slice(0, maxChars);
  }
  return '';
}

function getEntryContent(
  entry: JsonEntry,
  expectType?: string,
): Array<Record<string, unknown>> | undefined {
  if (expectType !== undefined && entry.type !== expectType) return undefined;
  const message = entry.message;
  if (typeof message !== 'object' || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return undefined;
  return msg.content as Array<Record<string, unknown>>;
}

function findAssistantEntry(
  entries: JsonEntry[],
  toolUseId?: string,
): AssistantMatch | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const content = getEntryContent(entry, 'assistant');
    if (!content) continue;
    if (toolUseId && !content.some((b) => b.type === 'tool_use' && b.id === toolUseId)) continue;
    return buildMatch(entries, i, content);
  }
  return null;
}

function buildMatch(
  entries: JsonEntry[],
  index: number,
  content: Array<Record<string, unknown>>,
): AssistantMatch {
  const entry = entries[index];
  const message = (entry.message ?? {}) as Record<string, unknown>;
  const model = getModel(entry, message);
  const usage = (message.usage ?? {}) as Record<string, unknown>;

  let thinking = extractBlockContent(content, 'thinking', THINKING_MAX_CHARS);
  let text = extractBlockContent(content, 'text', TEXT_MAX_CHARS);

  // Content blocks (thinking, text, tool_use) may be split across consecutive
  // assistant entries — scan adjacent entries to collect missing pieces.
  if (!thinking || !text) {
    for (let offset = -5; offset <= 5; offset++) {
      if (offset === 0) continue;
      const adjIdx = index + offset;
      if (adjIdx < 0 || adjIdx >= entries.length) continue;
      const adjContent = getEntryContent(entries[adjIdx], 'assistant');
      if (!adjContent) continue;
      if (!thinking) {
        thinking = extractBlockContent(adjContent, 'thinking', THINKING_MAX_CHARS);
      }
      if (!text) {
        text = extractBlockContent(adjContent, 'text', TEXT_MAX_CHARS);
      }
      if (thinking && text) break;
    }
  }

  return { model, usage, thinking, text };
}

function extractToolResultContent(block: Record<string, unknown>): string {
  const raw = block.content;
  // String form: {"type":"tool_result","content":"output text"}
  if (typeof raw === 'string') return raw;
  // Array form: {"type":"tool_result","content":[{"type":"text","text":"output"}]}
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (typeof item === 'object' && item !== null && 'text' in item) {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function findToolResult(
  entries: JsonEntry[],
  toolUseId: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'user') continue;

    const content = getEntryContent(entry, 'user');
    if (!content) continue;

    for (const block of content) {
      if (
        block.type === 'tool_result' &&
        block.tool_use_id === toolUseId
      ) {
        const text = extractToolResultContent(block);
        return text ? text.slice(0, TOOL_RESULT_MAX_CHARS) : undefined;
      }
    }
  }

  return undefined;
}

const TRANSCRIPT_CACHE_MAX = 50;

// Cache parsed transcript entries keyed by (path, fileSize) to avoid re-reading
// and re-parsing the same file on consecutive events within an LLM interaction.
const transcriptCache = new Map<string, { size: number; entries: JsonEntry[] }>();

async function loadTranscriptEntries(
  filePath: string,
  bypassCache = false,
): Promise<JsonEntry[]> {
  try {
    if (!bypassCache) {
      const { size } = await stat(filePath);
      const cached = transcriptCache.get(filePath);
      if (cached && cached.size === size) return cached.entries;
    }

    const result = await readTailBlock(filePath, TAIL_BYTES);
    if (!result.text) return [];
    const entries = parseEntries(result.text.split('\n'));
    // Always update cache so subsequent events see the latest state.
    transcriptCache.set(filePath, { size: result.fileSize, entries });
    if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
      const first = transcriptCache.keys().next().value;
      if (first !== undefined) transcriptCache.delete(first);
    }
    return entries;
  } catch {
    return [];
  }
}

export interface ExtractOptions {
  /** When true, retry until tool_result lands in the transcript (PostToolUse).
   *  When false/omitted, return as soon as the assistant entry is found (PreToolUse). */
  requireToolResult?: boolean;
}

export async function extractModelFeedback(
  transcriptPath: string,
  toolUseId?: string,
  opts?: ExtractOptions,
): Promise<ModelFeedback | null> {
  const requireToolResult = opts?.requireToolResult === true;
  let lastError: unknown;
  let lastReason = '';

  for (let attempt = 0; attempt <= TRANSCRIPT_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      const delay = TRANSCRIPT_RETRY_DELAYS_MS[attempt - 1];
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const entries = await loadTranscriptEntries(transcriptPath, attempt > 0);
      if (!entries.length) {
        lastReason = 'transcript empty';
        continue;
      }

      const found = findAssistantEntry(entries, toolUseId);
      if (!found) {
        lastReason = `assistant entry not found for tool_use_id=${toolUseId ?? '(none)'}`;
        continue;
      }

      let toolResult: string | undefined;
      if (toolUseId) {
        toolResult = findToolResult(entries, toolUseId);
        // Only retry for missing tool_result when the caller explicitly expects it
        // (PostToolUse). On PreToolUse the tool hasn't executed yet, so retrying
        // would just waste time.
        if (toolResult === undefined && requireToolResult && attempt < TRANSCRIPT_RETRY_MAX) {
          lastReason = `tool_result not found for ${toolUseId}`;
          continue;
        }
      }

      const usage: TokenUsage = {
        input_tokens: toNumber(found.usage.input_tokens, 0),
        output_tokens: toNumber(found.usage.output_tokens, 0),
        cache_read_input_tokens: typeof found.usage.cache_read_input_tokens === 'number'
          ? found.usage.cache_read_input_tokens
          : undefined,
        cache_creation_input_tokens: typeof found.usage.cache_creation_input_tokens === 'number'
          ? found.usage.cache_creation_input_tokens
          : undefined,
      };

      return {
        model: found.model,
        usage,
        thinking: found.thinking || undefined,
        text: found.text || undefined,
        tool_result: toolResult,
      };
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    console.error(
      '[ModelFeedback] read failed: %s',
      lastError instanceof Error ? lastError.message : lastError,
    );
  } else if (lastReason) {
    console.log('[ModelFeedback] extraction failed: %s', lastReason);
  }
  return null;
}
