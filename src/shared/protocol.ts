// ── Pairing ──

export const VALID_LINK_TYPES = ['lan', 'tunnel', 'wss', 'relay-official', 'relay-private'] as const;

export type LinkType = (typeof VALID_LINK_TYPES)[number];

export interface LinkConfig {
  id: string; // stable identifier e.g. "lan-default", "ngrok-1"
  type: LinkType;
  label: string; // human-readable: "Home LAN", "ngrok Tunnel"
  url: string; // full WS URL base: "ws://192.168.1.100:16321" or "wss://xxx.ngrok-free.app"
  enabled: boolean; // whether to include in QR/pairing
}

/** QR code payload: gateway connection info. */
export interface PairingInfo {
  h: string; // host (LAN IP or domain for NAT traversal)
  p: number; // port
  k: string; // base64-encoded 32-byte AES-256 key (used for both auth and encryption)
  links?: LinkConfig[]; // optional multi-link configuration
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
}

// ── Hook event payload ──

export interface SSEHookEvent {
  session_id: string;
  [key: string]: unknown;
}

/** A raw event tied to its source session. */
export interface SessionEvent {
  sessionId: string;
  event: SSEHookEvent;
}

// ── Gateway mode ──

export type GatewayMode = 'bystander' | 'takeover';

// ── WebSocket protocol: Gateway -> Frontend ──

export interface PendingInteraction {
  sessionId: string;
  eventId: string;
  event: SSEHookEvent;
}

export type GatewayMessage =
  | { type: 'connected'; sessions: SessionInfo[]; mode: GatewayMode; recentEvents: { sessionId: string; event: SSEHookEvent }[]; pendingInteractions: PendingInteraction[] }
  | { type: 'session_start'; session: SessionInfo }
  | { type: 'session_end'; sessionId: string }
  | { type: 'event'; sessionId: string; event: SSEHookEvent }
  | { type: 'mode_changed'; mode: GatewayMode };

// ── WebSocket protocol: Frontend -> Gateway ──

export type InteractionResponse = Record<string, unknown>;

export type ClientMessage =
  | { type: 'takeover' }
  | { type: 'release' }
  | { type: 'interact'; sessionId: string; eventId: string; response: InteractionResponse }
  | { type: 'request_sessions'; lastEventSeq?: number };
