import type { HookEventName } from '../../shared/protocol.js';

export interface PushPayload {
  sessionId: string;
  eventId: string;
  eventName: HookEventName;
  toolName?: string;
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

function buildNotification(payload: PushPayload): { title: string; body: string } {
  const toolLabel = payload.toolName ?? 'tool';

  switch (payload.eventName) {
    case 'PermissionRequest':
      return { title: 'Permission Request', body: `Claude wants to use ${toolLabel}` };
    case 'Stop':
    case 'SubagentStop':
      return { title: 'Stop Request', body: 'Claude wants to stop' };
    case 'Elicitation':
      return { title: 'Question', body: 'Claude has a question' };
    case 'PreToolUse':
      if (payload.toolName === 'AskUserQuestion') {
        return { title: 'Question', body: 'Claude has a question' };
      }
      if (payload.toolName === 'ExitPlanMode') {
        return { title: 'Plan Review', body: 'Claude wants to exit plan mode' };
      }
      return { title: 'Approval Needed', body: `Claude wants to use ${toolLabel}` };
    default:
      return { title: 'MyPilot', body: 'New interaction event' };
  }
}
