import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { runCli, PID_DIR, PID_PATH, DEFAULT_PORT, SETTINGS_PATH } from "./cli.js";

// ── Mocks ──

vi.mock("./gateway/server.js", () => ({
  createServer: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock("./gateway/token-store.js", () => ({
  getOrCreateToken: vi.fn(() => "mock-token-123"),
  detectLanIP: vi.fn(() => "192.168.1.100"),
}));

vi.mock("./gateway/qr-display.js", () => ({
  displayConnectionInfo: vi.fn(),
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
    it("starts server with port, logDir and token", async () => {
      const { createServer } = await import("./gateway/server.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(createServer).toHaveBeenCalledWith(
        DEFAULT_PORT,
        join(testPidDir, "logs"),
        "mock-token-123",
      );
    });

    it("gets or creates token and detects LAN IP", async () => {
      const { getOrCreateToken, detectLanIP } = await import("./gateway/token-store.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(getOrCreateToken).toHaveBeenCalledWith(testPidDir);
      expect(detectLanIP).toHaveBeenCalled();
    });

    it("displays connection info on startup", async () => {
      const { displayConnectionInfo } = await import("./gateway/qr-display.js");

      await runCli(makeArgv("gateway"), testPidDir, testPidPath);

      expect(displayConnectionInfo).toHaveBeenCalledWith("192.168.1.100", DEFAULT_PORT, "mock-token-123");
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

    it("displays pairing info when token exists", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(join(testPidDir, "token"), "test-token-abc", "utf-8");

      await runCli(makeArgv("pair-info"), testPidDir, testPidPath);

      const { displayConnectionInfo } = await import("./gateway/qr-display.js");
      expect(displayConnectionInfo).toHaveBeenCalledWith("192.168.1.100", DEFAULT_PORT, "test-token-abc");
    });

    it("shows pairing header in output", async () => {
      mkdirSync(testPidDir, { recursive: true });
      writeFileSync(join(testPidDir, "token"), "test-token-abc", "utf-8");

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
