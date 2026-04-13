#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
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
  console.log("  gateway     Start the Gateway server");
  console.log("  status      Check Gateway status");
  console.log("  pair-info   Show pairing info (IP + QR code)");
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

async function showPairInfo(pidDir: string): Promise<void> {
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

  const lanIP = detectLanIP();
  console.log(`MyPilot Gateway pairing info:`);
  displayConnectionInfo(lanIP, DEFAULT_PORT, token);
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
    case "gateway":
      await startGateway(pidDir, pidPath);
      break;
    case "status":
      await checkStatus(pidPath);
      break;
    case "pair-info":
      await showPairInfo(pidDir);
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
// Check if this module is the main entry point
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("cli.js") ||
    process.argv[1].endsWith("dist/backend/cli.js"));

if (isMainModule && process.env.VITEST === undefined) {
  runCli(process.argv);
}
