#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, realpathSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createServer } from "./gateway/server.js";
import { getOrCreateToken, detectLanIP } from "./gateway/token-store.js";
import { displayConnectionInfo } from "./gateway/qr-display.js";
import { mergeHooksIntoSettings, buildHooksConfig } from "./gateway/hooks-config.js";

export const PID_DIR = join(homedir(), ".mypilot");
export const PID_PATH = join(PID_DIR, "gateway.pid");
export const DEFAULT_PORT = 16321;
export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

function readPidFile(pidPath: string): number | null {
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function printUsage(): void {
  console.log("Usage: mypilot <command>");
  console.log("");
  console.log("Commands:");
  console.log("  start       Start Gateway in background");
  console.log("  stop        Stop background Gateway");
  console.log("  gateway     Start Gateway in foreground");
  console.log("  status      Check Gateway status");
  console.log("  pair-info   Show pairing info (IP + QR code)");
  console.log("              Optional: pair-info <domain[:port]> for NAT traversal");
  console.log("  init-hooks  Configure Claude Code hooks");
}

async function startGateway(pidDir: string, pidPath: string): Promise<void> {
  // Check if already running
  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(`Gateway is already running (PID ${existingPid})`);
    process.exit(1);
  }

  // Get or create persistent token
  mkdirSync(pidDir, { recursive: true });
  const token = getOrCreateToken(pidDir);
  const logDir = join(pidDir, "logs");

  const server = createServer(DEFAULT_PORT, logDir, token);

  await server.start();

  // Write PID file
  writeFileSync(pidPath, String(process.pid), "utf-8");

  // Display connection info with QR code
  const lanIP = detectLanIP();
  console.log(`Gateway running at http://localhost:${DEFAULT_PORT}`);
  displayConnectionInfo(lanIP, DEFAULT_PORT, token);

  // Handle SIGINT for graceful shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down gateway...");
    await server.stop();

    try {
      unlinkSync(pidPath);
    } catch {
      // PID file may already be deleted
    }

    console.log("Gateway stopped.");
    process.exit(0);
  });
}

function resolveSelfScriptPath(): string {
  // When running via tsx, process.argv[1] points to tsx's loader.
  // When running compiled JS, it points to cli.js directly.
  // We use import.meta.url to get the current file path reliably.
  const url = import.meta.url;
  // file:// URL to filesystem path
  const filePath = url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url;
  // On macOS/Linux, pathname starts with /; on Windows it may start with /C:/
  return filePath;
}

async function startBackground(pidDir: string, pidPath: string): Promise<void> {
  // Check if already running
  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(`Gateway is already running (PID ${existingPid})`);
    process.exit(1);
  }

  mkdirSync(pidDir, { recursive: true });
  const logDir = join(pidDir, "logs");
  mkdirSync(logDir, { recursive: true });

  const logFile = join(logDir, "gateway.log");
  const scriptPath = resolveSelfScriptPath();

  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  const child = spawn(process.execPath, [scriptPath, "gateway"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env },
  });

  child.unref();

  // Wait for child to write PID file (up to 3 seconds)
  const childPid = child.pid;
  let attempts = 0;
  const maxAttempts = 30;
  const intervalMs = 100;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pid = readPidFile(pidPath);
    if (pid !== null && isProcessAlive(pid)) {
      const lanIP = detectLanIP();
      const token = getOrCreateToken(pidDir);
      console.log(`Gateway started in background (PID ${pid})`);
      console.log(`  URL: http://localhost:${DEFAULT_PORT}`);
      console.log(`  Log: ${logFile}`);
      displayConnectionInfo(lanIP, DEFAULT_PORT, token);
      return;
    }
    // Check if child itself crashed before writing PID
    if (!isProcessAlive(childPid!)) {
      console.error("Gateway failed to start. Check log file:");
      console.error(`  ${logFile}`);
      process.exit(1);
    }
    attempts++;
  }

  console.error("Gateway did not start within expected time. Check log file:");
  console.error(`  ${logFile}`);
  process.exit(1);
}

async function stopGateway(pidPath: string): Promise<void> {
  const pid = readPidFile(pidPath);

  if (pid === null) {
    console.log("Gateway is not running");
    return;
  }

  if (!isProcessAlive(pid)) {
    // Stale PID file, clean it up
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore
    }
    console.log("Gateway is not running (cleaned up stale PID file)");
    return;
  }

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may have died between check and kill
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore
    }
    console.log("Gateway stopped.");
    return;
  }

  // Wait for process to exit (up to 5 seconds)
  let attempts = 0;
  const maxAttempts = 50;
  const intervalMs = 100;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!isProcessAlive(pid)) {
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore
      }
      console.log("Gateway stopped.");
      return;
    }
    attempts++;
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }

  try {
    unlinkSync(pidPath);
  } catch {
    // ignore
  }
  console.log("Gateway killed (did not respond to SIGTERM).");
}

async function checkStatus(pidPath: string): Promise<void> {
  const pid = readPidFile(pidPath);

  if (pid === null) {
    console.log("Gateway is not running");
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log("Gateway is not running (stale PID file)");
    return;
  }

  console.log(`Gateway is running (PID ${pid}, port ${DEFAULT_PORT})`);
}

function parseDomainArg(domain: string): { host: string; port: number } {
  const colonIdx = domain.lastIndexOf(":");
  // IPv6 like [::1]:443 or bare [::1]
  if (domain.startsWith("[")) {
    const bracketEnd = domain.indexOf("]");
    if (bracketEnd === -1) return { host: domain, port: 443 };
    const host = domain.slice(0, bracketEnd + 1);
    const rest = domain.slice(bracketEnd + 1);
    if (rest.startsWith(":")) {
      const port = parseInt(rest.slice(1), 10);
      return { host, port: Number.isNaN(port) ? 443 : port };
    }
    return { host, port: 443 };
  }
  if (colonIdx !== -1) {
    const port = parseInt(domain.slice(colonIdx + 1), 10);
    if (!Number.isNaN(port)) {
      return { host: domain.slice(0, colonIdx), port };
    }
  }
  return { host: domain, port: 443 };
}

async function showPairInfo(pidDir: string, domainArg?: string): Promise<void> {
  const tokenPath = join(pidDir, "token");

  if (!existsSync(tokenPath)) {
    console.log("Gateway has not been started yet. Run 'mypilot gateway' first.");
    process.exit(1);
  }

  const token = readFileSync(tokenPath, "utf-8").trim();
  if (!token) {
    console.log("Token not found. Run 'mypilot gateway' first.");
    process.exit(1);
  }

  const host = domainArg ? parseDomainArg(domainArg).host : detectLanIP();
  const port = domainArg ? parseDomainArg(domainArg).port : DEFAULT_PORT;
  console.log(`MyPilot Gateway pairing info:`);
  displayConnectionInfo(host, port, token);
}

async function initHooks(settingsPath: string): Promise<void> {
  console.log("This will add MyPilot hook entries to your Claude Code settings:");
  console.log(`  ${settingsPath}`);
  console.log("");

  const config = buildHooksConfig();
  const eventCount = Object.keys(config).length;
  console.log(`  ${eventCount} hook events will be configured.`);
  console.log("");
  console.log("Existing hooks will be preserved. MyPilot hooks are only added where missing.");
  console.log("");

  const confirmed = await promptYesNo("Continue?");
  if (!confirmed) {
    console.log("Aborted.");
    process.exit(0);
  }

  try {
    const result = mergeHooksIntoSettings(settingsPath);

    if (result.added.length === 0 && result.skipped.length === 0) {
      console.log("No changes needed — all hooks are already configured.");
    } else {
      if (result.added.length > 0) {
        console.log(`Added ${result.added.length} hook(s): ${result.added.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} (already configured): ${result.skipped.join(", ")}`);
      }
    }

    console.log("");
    console.log("Done! Start the gateway with: mypilot gateway");
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export async function runCli(
  argv: string[],
  pidDir: string = PID_DIR,
  pidPath: string = PID_PATH,
  settingsPath: string = SETTINGS_PATH,
): Promise<void> {
  const command = argv[2];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case "start":
      await startBackground(pidDir, pidPath);
      break;
    case "stop":
      await stopGateway(pidPath);
      break;
    case "gateway":
      await startGateway(pidDir, pidPath);
      break;
    case "status":
      await checkStatus(pidPath);
      break;
    case "pair-info":
      await showPairInfo(pidDir, argv[3] as string | undefined);
      break;
    case "init-hooks":
      await initHooks(settingsPath);
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

// Entry point when run as a script (not during test import)
// Resolve symlinks so npm-linked binaries are detected correctly
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    const resolved = realpathSync(process.argv[1]);
    return resolved.endsWith("cli.ts") || resolved.endsWith("cli.js");
  } catch {
    return false;
  }
})();

if (isMainModule && process.env.VITEST === undefined) {
  runCli(process.argv);
}
