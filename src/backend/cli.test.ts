import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { ChildProcess } from "node:child_process";
import { runCli, PID_DIR, PID_PATH, DEFAULT_PORT, SETTINGS_PATH } from "./cli.js";

// ── Mocks ──

vi.mock("./gateway/server.js", () => ({
  createServer: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  })),
}));

const MOCK_KEY = Buffer.from("a".repeat(32), "utf-8");

vi.mock("./gateway/token-store.js", () => ({
  getOrCreateKey: vi.fn(() => MOCK_KEY),
  detectLanIP: vi.fn(() => "192.168.1.100"),
}));

vi.mock("./gateway/qr-display.js", () => ({
  displayConnectionInfo: vi.fn(),
}));

const MOCK_LINKS = [
  { id: 'lan-default', type: 'lan', label: 'LAN Direct', url: 'ws://192.168.1.100:16321', enabled: true },
];

vi.mock("./gateway/link-config.js", () => ({
  loadLinksConfig: vi.fn(() => MOCK_LINKS),
  saveLinksConfig: vi.fn(),
}));

vi.mock("./gateway/hooks-config.js", () => ({
  mergeHooksIntoSettings: vi.fn(() => ({
    added: ["PreToolUse", "Notification"],
    skipped: ["SessionStart"],
  })),
  buildHooksConfig: vi.fn(() => ({
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "curl ..." }] }],
    Notification: [{ matcher: "", hooks: [{ type: "command", command: "curl ..." }] }],
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "curl ..." }] }],
  })),
}));

vi.mock("node:readline", () => ({
  createInterface: vi.fn(() => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb("y"),
    close: vi.fn(),
  })),
}));

// Capture SIGINT handler
let sigintHandler: (() => void) | undefined;

const processOnSpy = vi.spyOn(process, "on");
processOnSpy.mockImplementation(function (this: typeof process, event: string, handler: any) {
  if (event === "SIGINT") {
    sigintHandler = handler;
  }
  return process;
} as any);

const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
  throw new ExitError(typeof code === "number" ? code : undefined);
});

class ExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code ?? 0})`);
  }
}

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// Mock child_process.spawn for start command
let mockSpawnChild: Partial<ChildProcess>;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    mockSpawnChild = {
      pid: 12345,
      unref: vi.fn(),
    };
    return mockSpawnChild as ChildProcess;
  }),
}));

// ── Helpers ──

const testPidDir = join(tmpdir(), "mypilot-cli-test");
const testPidPath = join(testPidDir, "gateway.pid");
const testSettingsPath = join(tmpdir(), "mypilot-test-settings.json");

function makeArgv(...args: string[]): string[] {
  return ["node", "cli.js", ...args];
}

function cleanPidDir(): void {
  if (existsSync(testPidDir)) {
    rmSync(testPidDir, { recursive: true, force: true });
  }
}

// ── Tests ──

describe("runCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sigintHandler = undefined;
    cleanPidDir();
  });

  afterEach(() => {
    cleanPidDir();
  });

  // ── No command / unknown command ──

  it("prints usage and exits with code 1 when no command is given", async () => {
    try {
      await runCli(makeArgv(), testPidDir, testPidPath);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      expect((e as ExitError).code).toBe(1);
    }
    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Usage");
  });

  it("prints usage and exits with code 1 for unknown command", async () => {
    try {
      await runCli(makeArgv("foobar"), testPidDir, testPidPath);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExitError);
      expect((e as ExitError).code).toBe(1);
    }
    const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Usage");
  });

  // ── gateway command ──

  describe("gateway", () => {
    it("starts server with port, logDir, key", async () => {
      const { createServer } = await import("./gateway/server.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(createServer).toHaveBeenCalledWith(
        DEFAULT_PORT,
        join(testPidDir, "logs"),
        MOCK_KEY,
      );
    });

    it("gets or creates key and detects LAN IP", async () => {
      const { getOrCreateKey, detectLanIP } = await import("./gateway/token-store.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(getOrCreateKey).toHaveBeenCalledWith(testPidDir);
      expect(detectLanIP).toHaveBeenCalled();
    });

    it("displays connection info on startup", async () => {
      const { displayConnectionInfo } = await import("./gateway/qr-display.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(displayConnectionInfo).toHaveBeenCalledWith("192.168.1.100", DEFAULT_PORT, MOCK_KEY, MOCK_LINKS);
    });

    it("writes PID file on start", async () => {
      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(existsSync(testPidPath)).toBe(true);
      const pid = parseInt(readFileSync(testPidPath, "utf-8").trim(), 10);
      expect(pid).toBe(process.pid);
    });

    it("prints startup message with URL", async () => {
      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain(`http://localhost:${DEFAULT_PORT}`);
    });

    it("refuses to start if PID file exists and process is alive", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      try {
        await runCli(makeArgv("gateway"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
        expect((e as ExitError).code).toBe(1);
      }

      const output = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/already running/i);
    });

    it("starts if PID file exists but process is dead", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, "999999999", "utf-8");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      const { createServer } = await import("./gateway/server.js");
      expect(createServer).toHaveBeenCalled();
    });

    it("registers SIGINT handler for graceful shutdown", async () => {
      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(sigintHandler).toBeDefined();
    });

    it("stops server and deletes PID file on SIGINT", async () => {
      const { createServer } = await import("./gateway/server.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      const mockServer = (createServer as any).mock.results.slice(-1)[0]?.value;

      expect(sigintHandler).toBeDefined();
      try {
        await sigintHandler!();
      } catch (e) {
        // SIGINT handler calls process.exit(0), which we mock to throw
        expect(e).toBeInstanceOf(ExitError);
        expect((e as ExitError).code).toBe(0);
      }

      expect(mockServer.stop).toHaveBeenCalled();
      expect(existsSync(testPidPath)).toBe(false);
    });

    it("prints shutdown message on SIGINT", async () => {
      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      consoleLogSpy.mockClear();
      try {
        await sigintHandler!();
      } catch {
        // expected: process.exit(0)
      }

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/shutting down|stopped/i);
    });
  });

  // ── status command ──

  describe("status", () => {
    it("reports not running when no PID file", async () => {
      await runCli(makeArgv("status"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not running/i);
    });

    it("reports not running when PID file exists but process is dead", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, "999999999", "utf-8");

      await runCli(makeArgv("status"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not running/i);
    });

    it("reports running when process is alive", async () => {
      mkdirSync(testPidDir, { recursive: true});
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      await runCli(makeArgv("status"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/running/i);
      expect(output).toContain(String(process.pid));
    });

    it("shows port in status output when running", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      await runCli(makeArgv("status"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain(String(DEFAULT_PORT));
    });

    it("detects PID reuse when start time mismatches", async () => {
      mkdirSync(testPidDir, { recursive: true });
      // Write PID file with a wrong start time to simulate PID reuse
      writeFileSync(testPidPath, `${process.pid}\nfake-start-time`, "utf-8");

      await runCli(makeArgv("status"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not running/i);
    });
  });

  // ── pair-info command ──

  describe("pair-info", () => {
    it("shows error when gateway has not been started", async () => {
      try {
        await runCli(makeArgv("pair-info"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
        expect((e as ExitError).code).toBe(1);
      }

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not been started/i);
    });

    it("displays pairing info when key exists", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(join(testPidDir, "key"), MOCK_KEY);

      await runCli(makeArgv("pair-info"), testPidDir, testPidPath);

      const { displayConnectionInfo } = await import("./gateway/qr-display.js");
      expect(displayConnectionInfo).toHaveBeenCalledWith("192.168.1.100", DEFAULT_PORT, MOCK_KEY, MOCK_LINKS);
    });

    it("shows pairing header in output", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(join(testPidDir, "key"), MOCK_KEY);

      await runCli(makeArgv("pair-info"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/pairing info/i);
    });
  });

  // ── init-hooks command ──

  describe("init-hooks", () => {
    it("shows confirmation prompt info before modifying", async () => {
      await runCli(makeArgv("init-hooks"), testPidDir, testPidPath, testSettingsPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/will be preserved/i);
      expect(output).toContain(testSettingsPath);
    });

    it("calls mergeHooksIntoSettings with correct path", async () => {
      const { mergeHooksIntoSettings } = await import("./gateway/hooks-config.js");

      await runCli(makeArgv("init-hooks"), testPidDir, testPidPath, testSettingsPath);

      expect(mergeHooksIntoSettings).toHaveBeenCalledWith(testSettingsPath);
    });

    it("shows summary of added and skipped hooks", async () => {
      await runCli(makeArgv("init-hooks"), testPidDir, testPidPath, testSettingsPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/added/i);
      expect(output).toMatch(/skipped/i);
    });

    it("shows settings path in prompt", async () => {
      await runCli(makeArgv("init-hooks"), testPidDir, testPidPath, testSettingsPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain(testSettingsPath);
    });
  });

  // ── start command ──

  describe("start", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let killSpy: any;

    beforeEach(() => {
      // Mock process.kill so fake PID 12345 appears alive
      const origKill = process.kill.bind(process);
      killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === 12345 && signal === 0) return true; // fake child is alive
        if (pid === 12345 && typeof signal === "string") return true;
        return origKill(pid, signal as any);
      }) as typeof process.kill);
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("spawns a detached child process", async () => {
      const { spawn } = await import("node:child_process");

      setTimeout(() => {
        mkdirSync(testPidDir, { recursive: true });
        writeFileSync(testPidPath, "12345", "utf-8");
      }, 50);

      await runCli(makeArgv("start"), testPidDir, testPidPath);

      expect(spawn).toHaveBeenCalled();
      const args = (spawn as any).mock.calls[0];
      expect(args[1]).toContain("gateway");
      expect(mockSpawnChild.unref).toHaveBeenCalled();
    });

    it("refuses to start if already running", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      try {
        await runCli(makeArgv("start"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
        expect((e as ExitError).code).toBe(1);
      }

      const output = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/already running/i);
    });

    it("creates log directory", async () => {
      setTimeout(() => {
        mkdirSync(testPidDir, { recursive: true });
        writeFileSync(testPidPath, "12345", "utf-8");
      }, 50);

      await runCli(makeArgv("start"), testPidDir, testPidPath);

      expect(existsSync(join(testPidDir, "logs"))).toBe(true);
    });

    it("prints started message with PID", async () => {
      setTimeout(() => {
        mkdirSync(testPidDir, { recursive: true });
        writeFileSync(testPidPath, "12345", "utf-8");
      }, 50);

      await runCli(makeArgv("start"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/started/i);
      expect(output).toContain("12345");
    });
  });

  // ── stop command ──

  describe("stop", () => {
    it("reports not running when no PID file", async () => {
      await runCli(makeArgv("stop"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not running/i);
    });

    it("cleans up stale PID file when process is dead", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, "999999999", "utf-8");

      await runCli(makeArgv("stop"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/not running/i);
      expect(existsSync(testPidPath)).toBe(false);
    });

    it("sends SIGTERM to running process", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      let sigtermSent = false;
      const origKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (pid === process.pid && signal === "SIGTERM") {
          sigtermSent = true;
          return true;
        }
        // After SIGTERM, pretend process died (signal 0 check returns false)
        if (pid === process.pid && signal === 0 && sigtermSent) {
          const err = new Error("ESRCH") as any;
          err.code = "ESRCH";
          throw err;
        }
        return origKill(pid, signal as any);
      });

      await runCli(makeArgv("stop"), testPidDir, testPidPath);

      expect(sigtermSent).toBe(true);
      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toMatch(/stopped/i);

      killSpy.mockRestore();
    });

    it("removes PID file after stopping", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(testPidPath, String(process.pid), "utf-8");

      let sigtermSent = false;
      const origKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
        if (signal === "SIGTERM") {
          sigtermSent = true;
          return true;
        }
        if (signal === 0 && sigtermSent) {
          const err = new Error("ESRCH") as any;
          err.code = "ESRCH";
          throw err;
        }
        return origKill(pid, signal as any);
      });

      await runCli(makeArgv("stop"), testPidDir, testPidPath);
      expect(existsSync(testPidPath)).toBe(false);

      killSpy.mockRestore();
    });
  });

  // ── link command ──

  describe("link", () => {
    it("lists configured links", async () => {
      await runCli(makeArgv("link", "list"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("lan-default");
      expect(output).toContain("LAN Direct");
    });

    it("lists links when no sub-command given", async () => {
      await runCli(makeArgv("link"), testPidDir, testPidPath);

      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("LAN Direct");
    });

    it("adds a tunnel link", async () => {
      const { loadLinksConfig, saveLinksConfig } = await import("./gateway/link-config.js");
      const links = [...MOCK_LINKS];
      (loadLinksConfig as any).mockReturnValue(links);

      await runCli(makeArgv("link", "add", "tunnel", "wss://abc.ngrok-free.app", "--label", "ngrok"), testPidDir, testPidPath);

      expect(saveLinksConfig).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("Added link");
      expect(output).toContain("id=");
    });

    it("rejects invalid link type", async () => {
      try {
        await runCli(makeArgv("link", "add", "cloudflare", "wss://x.com"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
      }

      const output = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("Invalid type");
    });

    it("removes a link", async () => {
      const { loadLinksConfig, saveLinksConfig } = await import("./gateway/link-config.js");
      const links = [...MOCK_LINKS];
      (loadLinksConfig as any).mockReturnValue(links);

      await runCli(makeArgv("link", "remove", "lan-default"), testPidDir, testPidPath);

      expect(saveLinksConfig).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("Removed link");
    });

    it("errors when removing non-existent link", async () => {
      try {
        await runCli(makeArgv("link", "remove", "nope"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
      }
    });

    it("enables a link", async () => {
      const { loadLinksConfig, saveLinksConfig } = await import("./gateway/link-config.js");
      const links = [{ ...MOCK_LINKS[0], enabled: false }];
      (loadLinksConfig as any).mockReturnValue(links);

      await runCli(makeArgv("link", "enable", "lan-default"), testPidDir, testPidPath);

      expect(saveLinksConfig).toHaveBeenCalled();
    });

    it("disables a link", async () => {
      const { loadLinksConfig, saveLinksConfig } = await import("./gateway/link-config.js");
      const links = [...MOCK_LINKS];
      (loadLinksConfig as any).mockReturnValue(links);

      await runCli(makeArgv("link", "disable", "lan-default"), testPidDir, testPidPath);

      expect(saveLinksConfig).toHaveBeenCalled();
    });

    it("rejects unknown sub-command", async () => {
      try {
        await runCli(makeArgv("link", "explode"), testPidDir, testPidPath);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExitError);
      }
    });
  });
});

// ── PID file path constants ──

describe("PID file paths", () => {
  it("PID_DIR defaults to ~/.mypilot", () => {
    expect(PID_DIR).toBe(join(homedir(), ".mypilot"));
  });

  it("PID_PATH points to gateway.pid inside PID_DIR", () => {
    expect(PID_PATH).toBe(join(homedir(), ".mypilot", "gateway.pid"));
  });

  it("SETTINGS_PATH points to ~/.claude/settings.json", () => {
    expect(SETTINGS_PATH).toBe(join(homedir(), ".claude", "settings.json"));
  });
});
