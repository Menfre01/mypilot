import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SSEHookEvent } from "../../shared/protocol.js";

describe("EventLogger", () => {
  let tempDir: string;
  let EventLogger: typeof import("./event-logger.js").EventLogger;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mypilot-test-"));
    EventLogger = (await import("./event-logger.js")).EventLogger;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create log directory if not exists", () => {
    const logDir = join(tempDir, "nested", "logs");
    new EventLogger(logDir);
    expect(existsSync(logDir)).toBe(true);
  });

  it("should append event as JSONL line with _timestamp and _sessionId", () => {
    const logger = new EventLogger(tempDir);
    const event: SSEHookEvent = {
      session_id: "sess-1",
      event_name: "SessionStart",
      foo: "bar",
    };

    logger.log("sess-1", event);

    const files = readdirSync(tempDir);
    expect(files).toHaveLength(1);

    const line = readFileSync(join(tempDir, files[0]), "utf-8").trim();
    const parsed = JSON.parse(line);

    expect(parsed._sessionId).toBe("sess-1");
    expect(parsed._timestamp).toBeTypeOf("number");
    expect(parsed.session_id).toBe("sess-1");
    expect(parsed.event_name).toBe("SessionStart");
    expect(parsed.foo).toBe("bar");
  });

  it("should use date-based filename", () => {
    const logger = new EventLogger(tempDir);
    logger.log("s1", { session_id: "s1", event_name: "PreToolUse" } as SSEHookEvent);

    const files = readdirSync(tempDir);
    expect(files[0]).toMatch(/^events-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it("should append multiple events to same file on same day", () => {
    const logger = new EventLogger(tempDir);

    logger.log("s1", { session_id: "s1", event_name: "SessionStart" } as SSEHookEvent);
    logger.log("s1", { session_id: "s1", event_name: "PreToolUse" } as SSEHookEvent);
    logger.log("s2", { session_id: "s2", event_name: "SessionStart" } as SSEHookEvent);

    const files = readdirSync(tempDir);
    expect(files).toHaveLength(1);

    const lines = readFileSync(join(tempDir, files[0]), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("should not throw on write failure", () => {
    // Create logger with a path that is a file (not a directory), causing write to fail
    const filePath = join(tempDir, "blocker");
    mkdirSync(filePath, { recursive: false });
    // Now make it impossible to write by pointing logDir to a non-writable nested path
    const logger = new EventLogger(join(filePath, "nested", "logs"));

    // Should not throw — the constructor created the directory, but let's test log() failure
    // by making the log file path unwritable
    const badDir = join(tempDir, "readonly");
    mkdirSync(badDir);

    // Use a logDir where the file can't be created
    const badLogger = new EventLogger(join("/nonexistent/path/that/cannot/be/created/deep"));
    // Should not throw
    expect(() => badLogger.log("s1", { session_id: "s1" } as SSEHookEvent)).not.toThrow();
  });

  // ── Sequence number support ──

  it("should write _seq field in log entry", () => {
    const logger = new EventLogger(tempDir);
    const event: SSEHookEvent = { session_id: "s1", event_name: "PreToolUse" };
    logger.log("s1", event, 42);

    const files = readdirSync(tempDir);
    const line = readFileSync(join(tempDir, files[0]), "utf-8").trim();
    const parsed = JSON.parse(line);

    expect(parsed._seq).toBe(42);
  });

  // ── readEventsAfter ──

  it("readEventsAfter returns events with seq > afterSeq", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const e1: SSEHookEvent = { session_id: "s1", event_name: "PreToolUse", event_id: "1" };
    const e2: SSEHookEvent = { session_id: "s1", event_name: "PostToolUse", event_id: "2" };
    const e3: SSEHookEvent = { session_id: "s1", event_name: "Notification", event_id: "3" };

    logger.log("s1", e1, 1);
    logger.log("s1", e2, 2);
    logger.log("s1", e3, 3);

    const result = logger.readEventsAfter(1, 100);
    expect(result).toHaveLength(2);
    expect(result[0].event.event_id).toBe("2");
    expect(result[1].event.event_id).toBe("3");
  });

  it("readEventsAfter respects maxCount", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 10; i++) {
      logger.log("s1", { session_id: "s1", event_name: "PreToolUse", event_id: i.toString(36) } as SSEHookEvent, i);
    }

    const result = logger.readEventsAfter(5, 3);
    expect(result).toHaveLength(3);
  });

  it("readEventsAfter returns empty when no events after seq", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.log("s1", { session_id: "s1", event_name: "PreToolUse", event_id: "1" } as SSEHookEvent, 1);

    const result = logger.readEventsAfter(10, 100);
    expect(result).toHaveLength(0);
  });

  // ── loadRecentEvents ──

  it("loadRecentEvents returns last N events", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 10; i++) {
      logger.log("s1", { session_id: "s1", event_name: "PreToolUse", event_id: i.toString(36) } as SSEHookEvent, i);
    }

    const result = logger.loadRecentEvents(3);
    expect(result).toHaveLength(3);
    // Should be the last 3 events
    expect(result[0].event.event_id).toBe((8).toString(36));
    expect(result[2].event.event_id).toBe((10).toString(36));
  });

  it("loadRecentEvents returns all if fewer than count", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.log("s1", { session_id: "s1", event_name: "PreToolUse", event_id: "1" } as SSEHookEvent, 1);
    logger.log("s1", { session_id: "s1", event_name: "PostToolUse", event_id: "2" } as SSEHookEvent, 2);

    const result = logger.loadRecentEvents(100);
    expect(result).toHaveLength(2);
  });

  it("loadRecentEvents returns empty for empty log", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const result = logger.loadRecentEvents(100);
    expect(result).toHaveLength(0);
  });

  // ── SessionMessage 日志 ──

  it("logSessionMessage 写入带 _timestamp 和 _seq 的 JSONL 行", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const msg = {
      sessionId: 's1',
      seq: 1,
      timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'PreToolUse' },
    };

    logger.logSessionMessage(msg);

    const files = readdirSync(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session-s1-\d{4}-\d{2}-\d{2}\.jsonl$/);

    const line = readFileSync(join(tempDir, files[0]), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed._timestamp).toBeTypeOf('number');
    expect(parsed._seq).toBe(1);
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.source).toBe('hook');
  });

  it("logSessionMessage 处理 hook source 消息", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const msg = {
      sessionId: 's1',
      seq: 1,
      timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'Notification', message: 'test' },
    };

    logger.logSessionMessage(msg);

    const files = readdirSync(tempDir);
    const line = readFileSync(join(tempDir, files[0]), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.source).toBe('hook');
    expect(parsed.event.event_name).toBe('Notification');
    expect(parsed.event.message).toBe('test');
  });

  it("logSessionMessage 处理 transcript source 消息", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const msg = {
      sessionId: 's1',
      seq: 2,
      timestamp: Date.now(),
      source: 'transcript' as const,
      entry: {
        index: 0,
        type: 'assistant' as const,
        timestamp: Date.now(),
        model: 'claude-4',
        blocks: [{ type: 'text' as const, text: 'Hello' }],
      },
    };

    logger.logSessionMessage(msg);

    const files = readdirSync(tempDir);
    const line = readFileSync(join(tempDir, files[0]), 'utf-8').trim();
    const parsed = JSON.parse(line);
    expect(parsed.source).toBe('transcript');
    expect(parsed.entry.type).toBe('assistant');
    expect(parsed.entry.model).toBe('claude-4');
  });

  it("logSessionMessage 写入失败时不抛异常", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(join('/nonexistent/path/deep'));

    expect(() => logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1' },
    })).not.toThrow();
  });

  // ── loadSessionHistory ──

  it("loadSessionHistory 返回指定 session 按 seq 排序的历史消息", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.logSessionMessage({
      sessionId: 's1', seq: 3, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'PostToolUse' },
    });
    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'PreToolUse' },
    });
    logger.logSessionMessage({
      sessionId: 's1', seq: 2, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'Notification' },
    });
    // 其他 session 的消息不应被返回
    logger.logSessionMessage({
      sessionId: 's2', seq: 4, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's2', event_name: 'SessionStart' },
    });

    const history = logger.loadSessionHistory('s1');
    expect(history).toHaveLength(3);
    expect(history.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(history.every(m => m.sessionId === 's1')).toBe(true);
  });

  it("loadSessionHistory 尊重 maxCount", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 5; i++) {
      logger.logSessionMessage({
        sessionId: 's1', seq: i, timestamp: Date.now(),
        source: 'hook' as const,
        event: { session_id: 's1', event_name: 'PreToolUse' },
      });
    }

    const history = logger.loadSessionHistory('s1', 3);
    expect(history).toHaveLength(3);
    // maxCount 返回最后的 N 条
    expect(history[0].seq).toBe(3);
    expect(history[2].seq).toBe(5);
  });

  it("loadSessionHistory 未知 session 返回空", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'PreToolUse' },
    });

    const history = logger.loadSessionHistory('unknown-session');
    expect(history).toHaveLength(0);
  });

  it("loadSessionHistory 从空日志返回空", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    const history = logger.loadSessionHistory('s1');
    expect(history).toHaveLength(0);
  });

  // ── readSessionMessagesAfter ──

  it("readSessionMessagesAfter 只返回 seq > afterSeq 的消息", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 5; i++) {
      logger.logSessionMessage({
        sessionId: 's1', seq: i, timestamp: Date.now(),
        source: 'hook' as const,
        event: { session_id: 's1', event_name: 'PreToolUse' },
      });
    }

    const result = logger.readSessionMessagesAfter('s1', 2);
    expect(result).toHaveLength(3);
    expect(result[0].seq).toBe(3);
    expect(result[2].seq).toBe(5);
  });

  it("readSessionMessagesAfter 尊重 maxCount", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 10; i++) {
      logger.logSessionMessage({
        sessionId: 's1', seq: i, timestamp: Date.now(),
        source: 'hook' as const,
        event: { session_id: 's1', event_name: 'PreToolUse' },
      });
    }

    const result = logger.readSessionMessagesAfter('s1', 3, 4);
    expect(result).toHaveLength(4);
    expect(result[0].seq).toBe(4);
    expect(result[3].seq).toBe(7);
  });

  it("readSessionMessagesAfter 无匹配时返回空", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'PreToolUse' },
    });

    const result = logger.readSessionMessagesAfter('s1', 100);
    expect(result).toHaveLength(0);
  });

  // ── getMaxSessionSeq ──

  it("getMaxSessionSeq 返回 session 日志中的最大 seq", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'SessionStart' },
    });
    logger.logSessionMessage({
      sessionId: 's1', seq: 5, timestamp: Date.now(),
      source: 'transcript' as const,
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [] },
    });
    logger.logSessionMessage({
      sessionId: 's2', seq: 3, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's2', event_name: 'PreToolUse' },
    });

    const maxSeq = logger.getMaxSessionSeq();
    expect(maxSeq).toBe(5);
  });

  it("getMaxSessionSeq 空日志返回 0", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    expect(logger.getMaxSessionSeq()).toBe(0);
  });

  // ── readTranscriptEntriesAfter ──

  it("readTranscriptEntriesAfter 从 session-*.jsonl 中读取 transcript 条目", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    // logSessionMessage 写入 session-{sessionId}-{date}.jsonl
    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'transcript' as const,
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [{ type: 'text', text: 'Hello' }] },
    });
    logger.logSessionMessage({
      sessionId: 's1', seq: 2, timestamp: Date.now(),
      source: 'transcript' as const,
      entry: { index: 1, type: 'user', timestamp: Date.now(), blocks: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result' }] },
    });
    // hook 消息不应被返回
    logger.logSessionMessage({
      sessionId: 's1', seq: 3, timestamp: Date.now(),
      source: 'hook' as const,
      event: { session_id: 's1', event_name: 'Notification' },
    });

    const result = logger.readTranscriptEntriesAfter(0, 100);
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(1);
    expect(result[0].entry.type).toBe('assistant');
    expect(result[1].seq).toBe(2);
    expect(result[1].entry.type).toBe('user');
  });

  it("readTranscriptEntriesAfter 按 afterSeq 过滤", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    for (let i = 1; i <= 5; i++) {
      logger.logSessionMessage({
        sessionId: 's1', seq: i, timestamp: Date.now(),
        source: 'transcript' as const,
        entry: { index: i - 1, type: 'assistant', timestamp: Date.now(), blocks: [] },
      });
    }

    const result = logger.readTranscriptEntriesAfter(2, 100);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.seq)).toEqual([3, 4, 5]);
  });

  it("readTranscriptEntriesAfter 无匹配时返回空", async () => {
    const { EventLogger: EL } = await import("./event-logger.js");
    const logger = new EL(tempDir);

    logger.logSessionMessage({
      sessionId: 's1', seq: 1, timestamp: Date.now(),
      source: 'transcript' as const,
      entry: { index: 0, type: 'assistant', timestamp: Date.now(), blocks: [] },
    });

    const result = logger.readTranscriptEntriesAfter(100, 100);
    expect(result).toHaveLength(0);
  });
});
