import type { HookEventName, APNEnvironment } from '../../shared/protocol.js';
import { t } from './i18n.js';

export interface PushPayload {
  sessionId: string;
  eventId: string;
  eventName: HookEventName;
  toolName?: string;
  /** Brief description of what's being requested (extracted from tool_input) */
  content?: string;
  locale?: string;
  environment?: APNEnvironment;
}

export interface SendResult {
  ok: boolean;
  /** Set when APNs reports the device token is no longer registered (HTTP 410). */
  reason?: 'unregistered';
}

export class PushService {
  private relayUrl: string;
  private apiKey: string;
  private gatewayId: string;
  private quotaExceeded = false;
  private quotaResetDate: string | null = null;

  constructor(relayUrl: string, apiKey: string, gatewayId: string) {
    this.relayUrl = relayUrl;
    this.apiKey = apiKey;
    this.gatewayId = gatewayId;
  }

  isAvailable(): boolean {
    if (!this.quotaExceeded) return true;
    const today = new Date().toISOString().slice(0, 10);
    if (this.quotaResetDate !== today) {
      this.quotaExceeded = false;
      this.quotaResetDate = null;
      return true;
    }
    return false;
  }

  async sendPush(deviceToken: string, payload: PushPayload): Promise<SendResult> {
    const { title, body } = buildNotification(payload);

    const category = categoryForEvent(payload.eventName);
    console.log('[PushService] event=%s category=%s', payload.eventName, category ?? 'none');

    return this.sendWithRetry(deviceToken, title, body, category, payload);
  }

  private async sendWithRetry(
    deviceToken: string,
    title: string,
    body: string,
    category: string | null,
    payload: PushPayload,
  ): Promise<SendResult> {
    const maxRetries = 3;
    const baseDelay = 1000;

    // Body is identical for all retries; do not rebuild inside the loop.
    const requestBody = JSON.stringify({
      gatewayId: this.gatewayId,
      deviceToken,
      environment: payload.environment,
      payload: {
        aps: {
          alert: { title, body },
          sound: 'default',
          badge: 1,
          ...(category ? { category } : {}),
        },
        session_id: payload.sessionId,
        event_id: payload.eventId,
        event_name: payload.eventName,
        tool_name: payload.toolName,
      },
    });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log('[PushService] retry %d/%d in %dms', attempt, maxRetries - 1, delay);
        await sleep(delay);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      try {
        const response = await fetch(`${this.relayUrl}/api/push`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: requestBody,
          signal: controller.signal,
        });

        if (response.ok) {
          // Relay returns 200 even when APNs rejects — parse body to confirm
          const relayBody = await readFirstBytes(response, 500).catch(() => '<read-error>');
          let relayOk = true;
          let apnsStatus: number | undefined;
          try {
            const parsed = JSON.parse(relayBody);
            apnsStatus = parsed.apnsStatus;
            if (parsed.ok === false) {
              relayOk = false;
              console.error(
                '[PushService] APNs rejected push: status=%s body=%s',
                parsed.apnsStatus ?? '?',
                parsed.apnsBody ?? relayBody,
              );
            }
          } catch { /* not JSON — assume success */ }
          if (relayOk) {
            return { ok: true };
          }
          return { ok: false, reason: apnsStatus === 410 ? 'unregistered' : undefined };
        }

        if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
          this.quotaExceeded = true;
          this.quotaResetDate = new Date().toISOString().slice(0, 10);
          console.log('[PushService] Daily quota exceeded, disabling push for today');
          return { ok: false };
        }
        if (response.status === HTTP_STATUS.UNAUTHORIZED) return { ok: false };

        // Read only first 500 bytes to avoid memory pressure on large error pages
        const relayBody = await readFirstBytes(response, 500).catch(() => '<read-error>');
        console.error(
          '[PushService] Push failed: HTTP %d body=%s',
          response.status,
          relayBody,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (attempt < maxRetries - 1) {
          console.error('[PushService] Push attempt failed (will retry): %s', msg);
        } else {
          console.error('[PushService] Push failed (no more retries): %s', msg);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    return { ok: false };
  }
}

const HTTP_STATUS = {
  UNAUTHORIZED: 401,
  TOO_MANY_REQUESTS: 429,
} as const;

const APNS_CATEGORY = {
  APPROVAL: 'APPROVAL',
  STOP: 'STOP',
} as const;

function categoryForEvent(eventName: HookEventName): string | null {
  switch (eventName) {
    case 'PermissionRequest':
      return APNS_CATEGORY.APPROVAL;
    case 'Stop':
    case 'SubagentStop':
      return APNS_CATEGORY.STOP;
    default:
      return null;
  }
}

function buildNotification(payload: PushPayload): { title: string; body: string } {
  const toolLabel = payload.toolName ?? 'tool';
  const { locale } = payload;

  switch (payload.eventName) {
    case 'PermissionRequest': {
      let bodyText: string;
      if (payload.content) {
        const brief = truncateTail(payload.content, 100);
        bodyText = `${toolLabel}: ${brief}`;
      } else {
        bodyText = t('wantsToUse', locale, { tool: toolLabel });
      }
      return { title: t('permissionRequest', locale), body: bodyText };
    }
    case 'Stop':
    case 'SubagentStop':
      return { title: t('stopRequest', locale), body: t('wantsToStop', locale) };
    case 'Elicitation':
      return { title: t('question', locale), body: t('hasAQuestion', locale) };
    case 'PreToolUse':
      if (payload.toolName === 'AskUserQuestion') {
        return { title: t('question', locale), body: t('hasAQuestion', locale) };
      }
      if (payload.toolName === 'ExitPlanMode') {
        return { title: t('planReview', locale), body: t('wantsToExitPlanMode', locale) };
      }
      return { title: t('approvalNeeded', locale), body: t('wantsToUse', locale, { tool: toolLabel }) };
    default:
      return { title: t('myPilot', locale), body: t('newInteractionEvent', locale) };
  }
}

function truncateTail(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFirstBytes(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel();
  } catch {
    // reader may already be cancelled
  }
  const decoder = new TextDecoder();
  const text = chunks.map(c => decoder.decode(c, { stream: true })).join('');
  return text.slice(0, maxBytes);
}
