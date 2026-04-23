import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushService, type PushPayload } from './push-service.js';
import type { HookEventName } from '../../shared/protocol.js';

describe('PushService', () => {
  let pushService: PushService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushService = new PushService('https://push.example.com', 'test-api-key', 'gateway-123');
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('sendPush', () => {
    it('sends push notification with correct payload', async () => {
      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'PermissionRequest',
        toolName: 'Bash',
      };

      const result = await pushService.sendPush('device-token-123', payload);

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://push.example.com/api/push',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Authorization': 'Bearer test-api-key',
            'Content-Type': 'application/json',
          },
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.gatewayId).toBe('gateway-123');
      expect(body.deviceToken).toBe('device-token-123');
      expect(body.payload.aps.alert.title).toBe('Permission Request');
      expect(body.payload.aps.alert.body).toBe('Claude wants to use Bash');
      expect(body.payload.session_id).toBe('session-1');
      expect(body.payload.event_id).toBe('event-1');
      expect(body.payload.event_name).toBe('PermissionRequest');
      expect(body.payload.tool_name).toBe('Bash');
    });

    it('returns false on fetch error', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'Stop',
      };

      const result = await pushService.sendPush('device-token-123', payload);
      expect(result).toBe(false);
    });

    it('returns false when response is not ok', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400 });

      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'Stop',
      };

      const result = await pushService.sendPush('device-token-123', payload);
      expect(result).toBe(false);
    });
  });

  describe('buildNotification', () => {
    it('builds correct notification for PermissionRequest', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PermissionRequest',
        toolName: 'Edit',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('Permission Request');
      expect(body.payload.aps.alert.body).toBe('Claude wants to use Edit');
    });

    it('builds correct notification for Stop', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'Stop',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('Stop Request');
      expect(body.payload.aps.alert.body).toBe('Claude wants to stop');
    });

    it('builds correct notification for Elicitation', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'Elicitation',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('Question');
      expect(body.payload.aps.alert.body).toBe('Claude has a question');
    });

    it('builds correct notification for AskUserQuestion', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PreToolUse',
        toolName: 'AskUserQuestion',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('Question');
      expect(body.payload.aps.alert.body).toBe('Claude has a question');
    });

    it('builds correct notification for ExitPlanMode', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PreToolUse',
        toolName: 'ExitPlanMode',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('Plan Review');
      expect(body.payload.aps.alert.body).toBe('Claude wants to exit plan mode');
    });

    it('builds correct notification for unknown event', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'UnknownEvent' as HookEventName,
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('MyPilot');
      expect(body.payload.aps.alert.body).toBe('New interaction event');
    });

    it('uses "tool" when toolName is not provided', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PermissionRequest',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.body).toBe('Claude wants to use tool');
    });
  });
});
