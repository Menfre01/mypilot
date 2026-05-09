import { classifyEntry } from './transcript-reader.js';
import type { SessionMessage, SSEHookEvent } from '../../shared/protocol.js';

interface StreamJsonMessage {
  type: string;
  subtype?: string;
  message?: Record<string, unknown>;
  session_id: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  hook_event?: string;
  hook_id?: string;
  hook_name?: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  usage?: Record<string, unknown>;
  duration_ms?: number;
  stop_reason?: string;
  timestamp?: string;
}

export function adaptStreamJsonLine(
  rawLine: string,
  nextSeq: () => number,
): SessionMessage | null {
  let msg: StreamJsonMessage;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    return null;
  }

  const sessionId = msg.session_id;
  if (!sessionId) return null;

  const timestamp = Date.now();

  switch (msg.type) {
    case 'assistant':
    case 'user': {
      const parsed = classifyEntry(msg as unknown as Record<string, unknown>);
      if (!parsed) return null;
      return {
        sessionId,
        seq: nextSeq(),
        timestamp,
        source: 'transcript',
        entry: {
          index: -1,
          type: msg.type as 'assistant' | 'user',
          timestamp,
          model: parsed.model,
          usage: parsed.usage,
          blocks: parsed.blocks,
        },
      };
    }

    case 'system': {
      if (msg.subtype === 'hook_started' && msg.hook_event) {
        const event: SSEHookEvent = {
          session_id: sessionId,
          event_name: msg.hook_event,
          event_id: msg.hook_id ?? '',
          timestamp,
        };
        if (msg.hook_name) event.hook_name = msg.hook_name;
        return {
          sessionId,
          seq: nextSeq(),
          timestamp,
          source: 'hook',
          event,
        };
      }
      // init, hook_response, and other system subtypes are metadata only
      return null;
    }

    case 'result': {
      const event: SSEHookEvent = {
        session_id: sessionId,
        event_name: 'SessionEnd',
        event_id: '',
        timestamp,
      };
      if (msg.subtype) event.subtype = msg.subtype;
      if (msg.usage) event.usage = msg.usage;
      if (msg.duration_ms != null) event.duration_ms = msg.duration_ms;
      if (msg.stop_reason) event.stop_reason = msg.stop_reason;
      return {
        sessionId,
        seq: nextSeq(),
        timestamp,
        source: 'hook',
        event,
      };
    }

    default:
      return null;
  }
}

/** 从 stream-json 消息中提取 Claude 的真实 session_id（兼容 init 和 hook_started 等所有消息类型） */
export function extractInitSessionId(rawLine: string): string | null {
  try {
    const msg = JSON.parse(rawLine);
    if (msg && typeof msg.session_id === 'string') {
      return msg.session_id;
    }
  } catch {
    // ignore
  }
  return null;
}
