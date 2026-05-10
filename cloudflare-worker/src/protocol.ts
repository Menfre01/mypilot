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

export type SessionMode = 'pty' | 'headless';

export type SessionSource = 'desktop' | 'mobile' | 'detached';

export interface SessionInfo {
  id: string;
  color: string;
  colorIndex: number;
  startedAt: number;
  displayName?: string;
  source?: SessionSource;
  cwd?: string;
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

// ── Directory item ──

export interface DirectoryItem {
  path: string;
  label: string;
  source: 'recent' | 'suggestion' | 'current';
}

// ── Command item ──

export interface CommandItem {
  name: string;
  description: string;
  requiresArgs: boolean;
}

// ── Token stats ──

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TokenStatsPayload {
  records: Record<string, Record<string, Record<string, TokenBreakdown>>>;
  lastUpdated: string;
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
  | GatewayModeChanged
  | { type: 'session_error'; sessionId: string; message: string }
  | { type: 'session_status_changed'; sessionId: string; source: SessionSource }
  | { type: 'token_stats_update'; stats: TokenStatsPayload }
  | { type: 'directories_list'; items: DirectoryItem[] }
  | { type: 'validate_path_result'; path: string; ok: boolean; error?: string }
  | { type: 'commands_list'; commands: CommandItem[] };

export interface GatewayConnected {
  type: 'connected';
  protocolVersion: number;
  sessions: SessionInfo[];
  mode: GatewayMode;
  recentEvents: SessionEvent[];
  pendingInteractions: PendingInteraction[];
  takeoverOwner?: string;
  transcriptEntries?: { sessionId: string; seq: number; entry: TranscriptEntry }[];
  tokenStats?: TokenStatsPayload;
  commands?: CommandItem[];
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

export type APNEnvironment = 'sandbox' | 'production';
/** @deprecated use APNEnvironment */
export type PushEnvironment = APNEnvironment;
export type DevicePlatform = 'ios' | 'android' | 'web' | 'desktop';

export type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: Record<string, unknown> }
  | { type: 'start_session'; cwd?: string; model?: string; displayName?: string }
  | { type: 'send_prompt'; sessionId: string; prompt: string }
  | { type: 'stop_session'; sessionId: string }
  | { type: 'interrupt_session'; sessionId: string }
  | { type: 'request_sessions'; lastEventSeq?: number }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'register_device'; platform: DevicePlatform; locale?: string }
  | { type: 'register_push'; deviceToken: string; environment?: APNEnvironment }
  | { type: 'subscribe_session'; sessionId: string; fromSeq: number }
  | { type: 'disconnect' }
  | { type: 'request_token_stats'; range: 'today' | 'week' | 'month' }
  | { type: 'request_directories' }
  | { type: 'validate_path'; path: string }
  | { type: 'refresh_commands' };

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
