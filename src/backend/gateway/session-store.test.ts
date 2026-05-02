import { describe, it, expect, vi } from "vitest";
import { SessionStore, SESSION_COLORS } from "./session-store.js";

describe("SessionStore", () => {
  it("registers a new session and returns correct info with color", () => {
    const store = new SessionStore();
    const info = store.register("session-1");

    expect(info.id).toBe("session-1");
    expect(info.color).toBe(SESSION_COLORS[0]);
    expect(info.colorIndex).toBe(0);
    expect(info.startedAt).toBeGreaterThan(0);
    expect(typeof info.startedAt).toBe("number");
  });

  it("returns same info when registering an existing session (idempotent)", () => {
    const store = new SessionStore();
    const first = store.register("session-1");
    const second = store.register("session-1");

    expect(second).toBe(first);
  });

  it("cycles colors after 8 sessions", () => {
    const store = new SessionStore();
    const ids = Array.from({ length: 9 }, (_, i) => `session-${i}`);

    const infos = ids.map((id) => store.register(id));

    // First 8 sessions get colors 0-7
    for (let i = 0; i < 8; i++) {
      expect(infos[i].colorIndex).toBe(i);
      expect(infos[i].color).toBe(SESSION_COLORS[i]);
    }

    // 9th session wraps back to colorIndex 0
    expect(infos[8].colorIndex).toBe(0);
    expect(infos[8].color).toBe(SESSION_COLORS[0]);
  });

  it("unregister removes a session", () => {
    const store = new SessionStore();
    store.register("session-1");

    expect(store.has("session-1")).toBe(true);
    store.unregister("session-1");
    expect(store.has("session-1")).toBe(false);
    expect(store.get("session-1")).toBeUndefined();
  });

  it("unregister is a no-op for non-existent session", () => {
    const store = new SessionStore();
    expect(() => store.unregister("no-such-session")).not.toThrow();
  });

  it("getAll returns all active sessions", () => {
    const store = new SessionStore();
    store.register("s1");
    store.register("s2");
    store.register("s3");

    const all = store.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);

    store.unregister("s2");
    const remaining = store.getAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("has returns correct boolean", () => {
    const store = new SessionStore();

    expect(store.has("session-x")).toBe(false);
    store.register("session-x");
    expect(store.has("session-x")).toBe(true);
    store.unregister("session-x");
    expect(store.has("session-x")).toBe(false);
  });

  it("touch updates last activity time", () => {
    const store = new SessionStore();
    store.register("s1");

    vi.useFakeTimers();
    const storeAny = store as unknown as { lastActivityAt: Map<string, number> };
    storeAny.lastActivityAt.set("s1", Date.now() - 60_000);

    store.touch("s1");
    expect(storeAny.lastActivityAt.get("s1")).toBe(Date.now());

    vi.useRealTimers();
  });

  it("touch is no-op for non-existent session", () => {
    const store = new SessionStore();
    expect(() => store.touch("no-such-session")).not.toThrow();
  });

  it("getStaleIds returns sessions inactive beyond threshold", () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const storeAny = store as unknown as { lastActivityAt: Map<string, number> };

    store.register("fresh");
    store.register("stale-1");
    store.register("stale-2");

    storeAny.lastActivityAt.set("stale-1", Date.now() - 31 * 60_000);
    storeAny.lastActivityAt.set("stale-2", Date.now() - 60 * 60_000);

    const stale = store.getStaleIds(30 * 60_000);
    expect(stale.sort()).toEqual(["stale-1", "stale-2"]);

    vi.useRealTimers();
  });

  it("unregister cleans up lastActivityAt", () => {
    const store = new SessionStore();
    const storeAny = store as unknown as { lastActivityAt: Map<string, number> };

    store.register("s1");
    expect(storeAny.lastActivityAt.has("s1")).toBe(true);

    store.unregister("s1");
    expect(storeAny.lastActivityAt.has("s1")).toBe(false);
  });

  it("markHidden excludes session from getAll by default", () => {
    const store = new SessionStore();
    store.register("parent");
    store.register("child");
    store.markHidden("child");

    const visible = store.getAll();
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe("parent");
  });

  it("getAll with includeHidden=true returns all sessions", () => {
    const store = new SessionStore();
    store.register("parent");
    store.register("child");
    store.markHidden("child");

    const all = store.getAll(true);
    expect(all).toHaveLength(2);
    expect(all.map(s => s.id).sort()).toEqual(["child", "parent"]);
  });

  it("markHidden is no-op for non-existent session", () => {
    const store = new SessionStore();
    store.markHidden("ghost");
    expect(store.getAll()).toHaveLength(0);
  });

  it("unregister cleans up hiddenIds", () => {
    const store = new SessionStore();
    store.register("child");
    store.markHidden("child");
    store.unregister("child");

    store.register("child");
    expect(store.getAll()).toHaveLength(1);
  });

  it("isHidden returns true for hidden session", () => {
    const store = new SessionStore();
    store.register("s1");
    store.markHidden("s1");
    expect(store.isHidden("s1")).toBe(true);
  });

  it("isHidden returns false for visible session", () => {
    const store = new SessionStore();
    store.register("s1");
    expect(store.isHidden("s1")).toBe(false);
  });

  it("isHidden returns false for non-existent session", () => {
    const store = new SessionStore();
    expect(store.isHidden("ghost")).toBe(false);
  });
});
