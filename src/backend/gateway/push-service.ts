import type { HookEventName } from '../../shared/protocol.js';

export interface PushPayload {
  sessionId: string;
  eventId: string;
  eventName: HookEventName;
  toolName?: string;
  /** Brief description of what's being requested (extracted from tool_input) */
  content?: string;
}

export class PushService {
  private relayUrl: string;
  private apiKey: string;
  private gatewayId: string;

  constructor(relayUrl: string, apiKey: string, gatewayId: string) {
    this.relayUrl = relayUrl;
    this.apiKey = apiKey;
    this.gatewayId = gatewayId;
  }

  async sendPush(deviceToken: string, payload: PushPayload): Promise<boolean> {
    const { title, body } = buildNotification(payload);

    try {
      const category = categoryForEvent(payload.eventName);
      console.log('[PushService] event=%s category=%s', payload.eventName, category ?? 'none');
      const response = await fetch(`${this.relayUrl}/api/push`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          gatewayId: this.gatewayId,
          deviceToken,
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
        }),
      });

      if (!response.ok) {
        console.error(`[PushService] Push failed: ${response.status}`);
      }

      return response.ok;
    } catch (error) {
      console.error('[PushService] Error sending push:', error);
      return false;
    }
  }
}

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

  switch (payload.eventName) {
    case 'PermissionRequest': {
      let body: string;
      if (payload.content) {
        const brief = truncateTail(payload.content, 100);
        body = `${toolLabel}: ${brief}`;
      } else {
        body = `请求使用 ${toolLabel}`;
      }
      return { title: '权限请求', body };
    }
    case 'Stop':
    case 'SubagentStop':
      return { title: '停止请求', body: 'Claude 请求停止' };
    case 'Elicitation':
      return { title: '问题', body: 'Claude 有问题' };
    case 'PreToolUse':
      if (payload.toolName === 'AskUserQuestion') {
        return { title: '问题', body: 'Claude 有问题' };
      }
      if (payload.toolName === 'ExitPlanMode') {
        return { title: '计划审查', body: 'Claude 请求退出计划模式' };
      }
      return { title: '需要审批', body: `请求使用 ${toolLabel}` };
    default:
      return { title: 'MyPilot', body: '新交互事件' };
  }
}

function truncateTail(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
