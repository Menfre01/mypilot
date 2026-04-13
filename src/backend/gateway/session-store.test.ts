import { describe, it, expect } from "vitest";
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
});
