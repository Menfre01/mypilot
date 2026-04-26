import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PushService, type PushPayload } from './push-service.js';
import type { HookEventName } from '../../shared/protocol.js';

function makeResponse(overrides: Partial<Response> = {}): Partial<Response> {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
}

describe('PushService', () => {
  let pushService: PushService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    pushService = new PushService('https://push.example.com', 'test-api-key', 'gateway-123');
    fetchMock = vi.fn().mockResolvedValue(makeResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('returns false on fetch error (after retries)', async () => {
      fetchMock.mockRejectedValue(new Error('Network error'));

      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'Stop',
      };

      const promise = pushService.sendPush('device-token-123', payload);
      // Advance past all retry delays: 0ms delay + 1000ms + 2000ms + 4000ms
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns false when response is not ok (after retries)', async () => {
      fetchMock.mockResolvedValue(makeResponse({ ok: false, status: 500 }));

      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'Stop',
      };

      const promise = pushService.sendPush('device-token-123', payload);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([429, 401])('does not retry on %i', async (status) => {
      fetchMock.mockResolvedValue(makeResponse({ ok: false, status }));

      const payload: PushPayload = {
        sessionId: 'session-1',
        eventId: 'event-1',
        eventName: 'Stop',
      };

      const result = await pushService.sendPush('device-token-123', payload);

      expect(result).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

  describe('buildNotification with zh-CN', () => {
    it('builds zh-CN notification for PermissionRequest', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PermissionRequest',
        toolName: 'Edit',
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('权限请求');
      expect(body.payload.aps.alert.body).toBe('请求使用 Edit');
    });

    it('builds zh-CN notification for Stop', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'Stop',
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('停止请求');
      expect(body.payload.aps.alert.body).toBe('Claude 请求停止');
    });

    it('builds zh-CN notification for Elicitation', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'Elicitation',
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('问题');
      expect(body.payload.aps.alert.body).toBe('Claude 有问题');
    });

    it('builds zh-CN notification for AskUserQuestion', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PreToolUse',
        toolName: 'AskUserQuestion',
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('问题');
      expect(body.payload.aps.alert.body).toBe('Claude 有问题');
    });

    it('builds zh-CN notification for ExitPlanMode', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'PreToolUse',
        toolName: 'ExitPlanMode',
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('计划审查');
      expect(body.payload.aps.alert.body).toBe('Claude 请求退出计划模式');
    });

    it('builds zh-CN notification for unknown event', async () => {
      const payload: PushPayload = {
        sessionId: 's1',
        eventId: 'e1',
        eventName: 'UnknownEvent' as PushPayload['eventName'],
        locale: 'zh-CN',
      };

      await pushService.sendPush('token', payload);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.aps.alert.title).toBe('MyPilot');
      expect(body.payload.aps.alert.body).toBe('新交互事件');
    });
  });
});
