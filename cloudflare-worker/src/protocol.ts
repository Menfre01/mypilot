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
  event: SSEHookEvent;
}

// ── Gateway mode ──

export type GatewayMode = 'bystander' | 'takeover';

// ── Protocol version ──

export const PROTOCOL_VERSION = 1;

// ── Gateway → Client messages ──

export type GatewayMessage =
  | GatewayConnected
  | GatewaySessionStart
  | GatewaySessionEnd
  | GatewayEvent
  | GatewayModeChanged;

export interface GatewayConnected {
  type: 'connected';
  protocolVersion: number;
  sessions: SessionInfo[];
  mode: GatewayMode;
  recentEvents: SessionEvent[];
  pendingInteractions: PendingInteraction[];
  takeoverOwner?: string;
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
  event: SSEHookEvent;
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
  | { type: 'register_push'; deviceToken: string; environment?: PushEnvironment };

// ── Encrypted envelope ──

export interface EncryptedEnvelope {
  iv: string;
  data: string;
}

// ── Demo constants ──

// Fixed 32-byte demo key base64-encoded
export const DEMO_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
