// ── Protocol version ──

/** Current protocol version. MAJOR bump = breaking changes (reject old clients). */
export const PROTOCOL_VERSION = 3;

// ── Pairing ──

export const VALID_LINK_TYPES = ['lan', 'tunnel'] as const;
export type LinkType = (typeof VALID_LINK_TYPES)[number];

export interface LinkConfig {
  id: string;
  type: LinkType;
  label: string;
  url: string;
  enabled: boolean;
}

/** QR code payload: gateway connection info. */
export interface PairingInfo {
  h: string;
  p: number;
  k: string;
  links?: LinkConfig[];
}

/** Encrypted message envelope for WebSocket communication. */
export interface EncryptedEnvelope {
  iv: string;   // base64-encoded 12-byte IV
  data: string; // base64-encoded (ciphertext + 16-byte GCM auth tag)
}

/** Response from GET /pair?key=X when valid. */
export interface PairResponse {
  ok: true;
  host: string;
  port: number;
}

// ── Hook event name union ──

export type HookEventName =
  // Category 1: user interaction (blocking)
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'Elicitation'
  // Category 2: can block, usually auto-approved
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'ConfigChange'
  | 'ElicitationResult'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'TeammateIdle'
  | 'WorktreeCreate'
  // Category 3: informational, never blocking
  | 'SessionStart'
  | 'SessionEnd'
  | 'InstructionsLoaded'
  | 'SubagentStart'
  | 'StopFailure'
  | 'PermissionDenied'
  | 'Notification'
  | 'PreCompact'
  | 'PostCompact'
  | 'CwdChanged'
  | 'FileChanged'
  | 'WorktreeRemove';

// ── Session info ──

export interface SessionInfo {
  id: string;
  color: string;
  colorIndex: number;
  startedAt: number;
  displayName?: string;
}

// ── Token usage ──

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ── Transcript entry types ──

export type TranscriptBlockType = 'thinking' | 'text' | 'tool_use' | 'tool_result';

export interface TranscriptBlock {
  type: TranscriptBlockType;
  /** thinking/text block content */
  thinking?: string;
  text?: string;
  /** tool_use block fields */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool_result block fields */
  tool_use_id?: string;
  content?: string;
  isError?: boolean;
}

export interface TranscriptEntry {
  /** Line index in transcript file, for dedup */
  index: number;
  type: 'assistant' | 'user';
  timestamp: number;
  model?: string;
  usage?: TokenUsage;
  blocks: TranscriptBlock[];
}

// ── Hook event payload ──

export interface SSEHookEvent {
  session_id: string;
  [key: string]: unknown;
}

/** A raw event tied to its source session. */
export interface SessionEvent {
  sessionId: string;
  seq: number;
  event: SSEHookEvent;
}

// ── SessionMessage：管道内统一消息结构 ──

export interface SessionMessage {
  sessionId: string;
  seq: number;
  timestamp: number;
  source: 'hook' | 'transcript';
  /** 当 source === 'hook' 时存在 */
  event?: SSEHookEvent;
  /** 当 source === 'transcript' 时存在 */
  entry?: TranscriptEntry;
}

// ── Gateway mode ──

export type GatewayMode = 'bystander' | 'takeover';

// ── WebSocket protocol: Gateway -> Frontend ──

export interface PendingInteraction {
  sessionId: string;
  eventId: string;
  event: SSEHookEvent;
}

export interface GatewayConnected {
  type: 'connected';
  protocolVersion: number;
  sessions: SessionInfo[];
  mode: GatewayMode;
  recentEvents: SessionEvent[];
  pendingInteractions: PendingInteraction[];
  takeoverOwner?: string;
  transcriptEntries?: { sessionId: string; seq: number; entry: TranscriptEntry }[];
}

export type GatewayMessage =
  | GatewayConnected
  | { type: 'session_start'; session: SessionInfo }
  | { type: 'session_end'; sessionId: string }
  | { type: 'event'; sessionId: string; seq: number; event: SSEHookEvent }
  | { type: 'transcript_entry'; sessionId: string; seq: number; entry: TranscriptEntry }
  | { type: 'mode_changed'; mode: GatewayMode; takeoverOwner?: string };

// ── WebSocket protocol: Frontend -> Gateway ──

export type InteractionResponse = Record<string, unknown>;

export type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: InteractionResponse }
  | { type: 'request_sessions'; lastEventSeq?: number }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'register_device'; platform: DevicePlatform; locale?: string }
  | { type: 'register_push'; deviceToken: string; environment?: APNEnvironment }
  | { type: 'subscribe_session'; sessionId: string; fromSeq: number }
  | { type: 'disconnect' };

export type DevicePlatform = 'ios' | 'android' | 'web' | 'desktop';

export type APNEnvironment = 'sandbox' | 'production';
