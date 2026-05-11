// ── Protocol version ──

/** Current protocol version. MAJOR bump = breaking changes (reject old clients). */
export const PROTOCOL_VERSION = 3;

/** Sentinel model name for synthetic/placeholder transcript entries that should not be tracked. */
export const SYNTHETIC_MODEL = '<synthetic>';

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

// ── Session activity ──

export type SessionActivityStatus = 'idle' | 'processing';

export interface SessionActivity {
  type: 'session_activity';
  sessionId: string;
  status: SessionActivityStatus;
  prompt?: string;
  timestamp: number;
}

export function makeSessionActivity(sessionId: string, prompt?: string): SessionActivity {
  return { type: 'session_activity', sessionId, status: 'processing', prompt, timestamp: Date.now() };
}

export function makeSessionIdle(sessionId: string): SessionActivity {
  return { type: 'session_activity', sessionId, status: 'idle', timestamp: Date.now() };
}

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
  tokenStats?: TokenStatsPayload;
  commands?: CommandItem[];
}

export interface DirectoryItem {
  path: string;
  label: string;
  /** 是否为建议目录（同级 git 项目），用于区分 UI 展示 */
  source: 'recent' | 'suggestion' | 'current';
}

// ── Clash command types ──

export interface CommandItem {
  name: string;          // e.g. '/rewind'
  description: string;   // 中文描述
  requiresArgs: boolean; // 是否需要参数（决定选中后是否自动发送）
}

export interface RewindTurn {
  index: number;    // 0-based
  role: string;     // 'User' | 'Assistant'
  summary: string;  // 轮次摘要
}

export type GatewayMessage =
  | GatewayConnected
  | { type: 'session_start'; session: SessionInfo }
  | { type: 'session_end'; sessionId: string }
  | { type: 'session_error'; sessionId: string; message: string }
  | { type: 'event'; sessionId: string; seq: number; event: SSEHookEvent }
  | { type: 'transcript_entry'; sessionId: string; seq: number; entry: TranscriptEntry }
  | { type: 'mode_changed'; mode: GatewayMode; takeoverOwner?: string }
  | { type: 'session_status_changed'; sessionId: string; source: SessionSource }
  | { type: 'token_stats_update'; stats: TokenStatsPayload }
  | { type: 'directories_list'; items: DirectoryItem[] }
  | { type: 'validate_path_result'; path: string; ok: boolean; error?: string }
  | { type: 'rewind_selector'; interactionId: string; sessionId: string; turns: RewindTurn[] }
  | { type: 'commands_list'; commands: CommandItem[] }
  | SessionActivity;

// ── WebSocket protocol: Frontend -> Gateway ──

export type InteractionResponse = Record<string, unknown>;

export type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: InteractionResponse }
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
  | { type: 'rewind_select'; interactionId: string; sessionId: string; turnIndex: number }
  | { type: 'rewind_cancel'; interactionId: string; sessionId: string }
  | { type: 'refresh_commands' };

export type DevicePlatform = 'ios' | 'android' | 'web' | 'desktop';

export type APNEnvironment = 'sandbox' | 'production';

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

// ── PTY Relay protocol (internal, CLI ↔ WS relay) ──

export interface PtyRelayClientMessage {
  type: 'pty_in' | 'pty_detach' | 'pty_resize';
  sessionId?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

export type PtyRelayServerMessage =
  | { type: 'pty_out'; data: string }
  | { type: 'pty_ready'; sessionId: string }
  | { type: 'session_detached'; sessionId: string }
  | { type: 'session_end'; sessionId: string }
  | { type: 'pty_error'; message: string };
