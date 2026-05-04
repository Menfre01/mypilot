// ── Link configuration ──

export interface LinkConfig {
  id: string;
  type: 'lan' | 'tunnel';
  label: string;
  url: string;
  enabled: boolean;
}

// ── Pairing ──

export interface PairingInfo {
  h: string;
  p: number;
  k: string;
  links?: LinkConfig[];
}

export interface PairResponse {
  ok: true;
  host: string;
  port: number;
}

// ── Session ──

export const SESSION_COLORS = [
  '#89b4fa', '#a6e3a1', '#f38ba8', '#f9e2af',
  '#b4befe', '#89dceb', '#fab387', '#cba6f7',
];

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
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  isError?: boolean;
}

export interface TranscriptEntry {
  index: number;
  type: 'assistant' | 'user';
  timestamp: number;
  model?: string;
  usage?: TokenUsage;
  blocks: TranscriptBlock[];
}

// ── Hook event ──

export interface SSEHookEvent {
  session_id: string;
  event_name: string;
  event_id: string;
  tool_name?: string;
  [key: string]: unknown;
}

// ── Pending interaction ──

export interface PendingInteraction {
  sessionId: string;
  eventId: string;
  event: SSEHookEvent;
}

// ── Session event ──

export interface SessionEvent {
  sessionId: string;
  seq: number;
  event: SSEHookEvent;
}

// ── Gateway mode ──

export type GatewayMode = 'bystander' | 'takeover';

// ── Protocol version ──

export const PROTOCOL_VERSION = 3;

// ── Gateway → Client messages ──

export type GatewayMessage =
  | GatewayConnected
  | GatewaySessionStart
  | GatewaySessionEnd
  | GatewayEvent
  | GatewayTranscriptEntry
  | GatewayModeChanged;

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

export interface GatewaySessionStart {
  type: 'session_start';
  session: SessionInfo;
}

export interface GatewaySessionEnd {
  type: 'session_end';
  sessionId: string;
}

export interface GatewayEvent {
  type: 'event';
  sessionId: string;
  seq: number;
  event: SSEHookEvent;
}

export interface GatewayTranscriptEntry {
  type: 'transcript_entry';
  sessionId: string;
  seq: number;
  entry: TranscriptEntry;
}

export interface GatewayModeChanged {
  type: 'mode_changed';
  mode: GatewayMode;
  takeoverOwner?: string;
}

// ── Client → Gateway messages ──

export type PushEnvironment = 'sandbox' | 'production';
export type DevicePlatform = 'ios' | 'android' | 'web' | 'desktop';

export type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: Record<string, unknown> }
  | { type: 'request_sessions'; lastEventSeq?: number }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'register_device'; platform: DevicePlatform; locale?: string }
  | { type: 'register_push'; deviceToken: string; environment?: PushEnvironment }
  | { type: 'subscribe_session'; sessionId: string; fromSeq?: number }
  | { type: 'disconnect' };

// ── Encrypted envelope ──

export interface EncryptedEnvelope {
  iv: string;
  data: string;
}

// ── Demo constants ──

// DEMO ONLY — provides NO real security. This fixed 32-byte key (0x00–0x1F)
// is public and anyone can decrypt or forge demo gateway traffic. Never reuse
// this key or the pattern of hardcoded keys for production data.
export const DEMO_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
