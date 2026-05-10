#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, realpathSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { get } from "node:http";
import { createServer } from "./gateway/server.js";
import { getOrCreateKey, detectLanIP } from "./gateway/token-store.js";
import { displayConnectionInfo } from "./gateway/qr-display.js";
import { mergeHooksIntoSettings, buildHooksConfig } from "./gateway/hooks-config.js";
import { loadLinksConfig, saveLinksConfig } from "./gateway/link-config.js";
import { loadPushConfig, savePushConfig, deletePushConfig, generateGatewayId, autoRegisterPush, getUserInfo, DEFAULT_RELAY_URL } from "./gateway/push-config.js";
import { VALID_LINK_TYPES, type LinkType, type PtyRelayServerMessage } from "../shared/protocol.js";
import { WebSocket } from "ws";
import { encrypt } from "./gateway/crypto.js";

export const PID_DIR = join(homedir(), ".mypilot");
export const PID_PATH = join(PID_DIR, "gateway.pid");
export const DEFAULT_PORT = 16321;
export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface PidInfo {
  pid: number;
  startTime: string | undefined;
}

function readPidFile(pidPath: string): PidInfo | null {
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const lines = content.split("\n");
    const pid = parseInt(lines[0]!, 10);
    if (Number.isNaN(pid)) return null;
    const startTime = lines[1]?.trim();
    return { pid, startTime: startTime || undefined };
  } catch {
    return null;
  }
}

function writePidFile(pidPath: string, pid: number): void {
  const startTime = getProcessStartTime(pid) ?? "";
  writeFileSync(pidPath, `${pid}\n${startTime}`, "utf-8");
}

const IS_LINUX = platform() === "linux";

function getProcessStartTime(pid: number): string | null {
  try {
    if (IS_LINUX) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8").trim();
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) return null;
      const afterComm = stat.slice(closeParen + 2).split(" ");
      return afterComm[19] ?? null;
    }
    const result = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8" }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number, expectedStartTime?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!expectedStartTime) return true;
  const actualStartTime = getProcessStartTime(pid);
  return actualStartTime === expectedStartTime;
}

function checkPortInUse(port: number): Promise<boolean> {
  if (process.env.VITEST !== undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ port, timeout: 300 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function getOrCreateKeySafe(dir: string): Buffer | null {
  try {
    const key = readFileSync(join(dir, "key"));
    if (key.length === 32) return key;
  } catch {
    // ignore
  }
  return null;
}

function checkExistingGateway(port: number, key: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(
      `http://localhost:${port}/pair?key=${encodeURIComponent(key.toString("base64"))}`,
      { timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data.ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function printUsage(): void {
  console.log("Usage: mypilot <command> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --help, -h    Show this help message");
  console.log("");
  console.log("Commands:");
  console.log("  start       Start Gateway in background");
  console.log("  stop        Stop background Gateway");
  console.log("  restart     Restart Gateway (stop + start)");
  console.log("  gateway     Start Gateway in foreground");
  console.log("  status      Check Gateway status");
  console.log("  pair-info   Show pairing info (IP + QR code)");
  console.log("  init-hooks  Configure Claude Code hooks");
  console.log("  session     Create or resume a Claude Code session");
  console.log("              session [--name <name>] [--cwd <path>] [--model <model>]");
  console.log("              session --resume <name-or-id>");
  console.log("              session --continue");
  console.log("              session kill <name-or-id>");
  console.log("              session ls [-w|--watch]");
  console.log("  link        Manage communication links");
  console.log("              link list");
  console.log("              link add <lan|tunnel> <url> [--label <label>]");
  console.log("              link remove <id>");
  console.log("              link enable <id>");
  console.log("              link disable <id>");
  console.log("  push        Manage push notification config");
  console.log("              push status");
  console.log("              push setup <relay-url> <api-key>");
  console.log("              push disable");
}

async function startGateway(pidDir: string, pidPath: string): Promise<void> {
  mkdirSync(pidDir, { recursive: true });
  const key = getOrCreateKey(pidDir);
  const lanIP = detectLanIP();
  const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);

  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid.pid, existingPid.startTime)) {
    console.log(`Gateway already running on port ${DEFAULT_PORT} (PID ${existingPid.pid})`);
    displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
    process.exit(0);
  }

  const logDir = join(pidDir, "logs");

  const portInUse = await checkPortInUse(DEFAULT_PORT);
  if (portInUse) {
    const isExisting = await checkExistingGateway(DEFAULT_PORT, key);
    if (isExisting) {
      console.log(`Gateway already running on port ${DEFAULT_PORT}`);
      displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
      process.exit(0);
    }
    console.error(`Port ${DEFAULT_PORT} is already in use by another application.`);
    console.error(`Check: lsof -i :${DEFAULT_PORT}`);
    process.exit(1);
  }

  let pushConfig = loadPushConfig(pidDir);
  if (!pushConfig) {
    const gatewayId = generateGatewayId(pidDir);
    const result = await autoRegisterPush(DEFAULT_RELAY_URL, gatewayId);
    if (result) {
      pushConfig = { relayUrl: DEFAULT_RELAY_URL, apiKey: result.apiKey, gatewayId };
      savePushConfig(pidDir, pushConfig);
    } else {
      console.log('Push auto-registration failed — push notifications will be unavailable');
    }
  }

  const server = createServer(DEFAULT_PORT, logDir, pidDir, key, pushConfig ?? undefined);

  writePidFile(pidPath, process.pid);

  try {
    await server.start();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      console.error(`Port ${DEFAULT_PORT} is already in use.`);
      console.error(`Check for running instances: lsof -i :${DEFAULT_PORT}`);
      console.error(`Stop existing gateway: mypilot stop`);
    } else {
      console.error(`Failed to start gateway: ${err instanceof Error ? err.message : String(err)}`);
    }
    try { unlinkSync(pidPath); } catch { /* ignore */ }
    process.exit(1);
  }

  console.log(`Gateway running at http://localhost:${DEFAULT_PORT}`);
  if (pushConfig) {
    console.log(`Push notifications enabled (${pushConfig.relayUrl})`);
  }
  displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);

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
  return fileURLToPath(import.meta.url);
}

async function startBackground(pidDir: string, pidPath: string): Promise<void> {
  mkdirSync(pidDir, { recursive: true });
  const key = getOrCreateKey(pidDir);
  const lanIP = detectLanIP();
  const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);

  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid.pid, existingPid.startTime)) {
    console.log(`Gateway already running on port ${DEFAULT_PORT} (PID ${existingPid.pid})`);
    displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
    process.exit(0);
  }

  const portInUse = await checkPortInUse(DEFAULT_PORT);
  if (portInUse) {
    const isExisting = await checkExistingGateway(DEFAULT_PORT, key);
    if (isExisting) {
      console.log(`Gateway already running on port ${DEFAULT_PORT}`);
      displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
      process.exit(0);
    }
    console.error(`Port ${DEFAULT_PORT} is already in use by another application.`);
    console.error(`Check: lsof -i :${DEFAULT_PORT}`);
    process.exit(1);
  }

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

  const childPid = child.pid;
  let attempts = 0;
  const maxAttempts = 30;
  const intervalMs = 100;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const info = readPidFile(pidPath);
    if (info !== null && isProcessAlive(info.pid, info.startTime)) {
      const lanIP = detectLanIP();
      const key = getOrCreateKey(pidDir);
      console.log(`Gateway started in background (PID ${info.pid})`);
      console.log(`  URL: http://localhost:${DEFAULT_PORT}`);
      console.log(`  Log: ${logFile}`);
      const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
      displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
      return;
    }
    if (childPid === undefined || !isProcessAlive(childPid)) {
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

async function stopGateway(pidDir: string, pidPath: string): Promise<void> {
  const info = readPidFile(pidPath);

  if (info === null || !isProcessAlive(info.pid, info.startTime)) {
    // PID file missing or stale — check port as fallback
    const portInUse = await checkPortInUse(DEFAULT_PORT);
    if (portInUse) {
      const key = await getOrCreateKeySafe(pidDir);
      if (key && await checkExistingGateway(DEFAULT_PORT, key)) {
        console.log(`Gateway is running on port ${DEFAULT_PORT} but PID file is missing.`);
        console.log(`Find the process: lsof -i :${DEFAULT_PORT}`);
        console.log(`Then stop it manually: kill <PID>`);
        process.exit(1);
      }
    }

    if (info !== null) {
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      console.log("Gateway is not running (cleaned up stale PID file)");
    } else {
      console.log("Gateway is not running");
    }
    return;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore
    }
    console.log("Gateway stopped.");
    return;
  }

  let attempts = 0;
  const maxAttempts = 50;
  const intervalMs = 100;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!isProcessAlive(info.pid)) {
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

  try {
    process.kill(info.pid, "SIGKILL");
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

async function checkStatus(pidDir: string, pidPath: string): Promise<void> {
  const info = readPidFile(pidPath);

  if (info !== null && isProcessAlive(info.pid, info.startTime)) {
    console.log(`Gateway is running (PID ${info.pid}, port ${DEFAULT_PORT})`);
    return;
  }

  // PID file missing or stale — check port as fallback
  const portInUse = await checkPortInUse(DEFAULT_PORT);
  if (portInUse) {
    const key = getOrCreateKeySafe(pidDir);
    if (key && await checkExistingGateway(DEFAULT_PORT, key)) {
      console.log(`Gateway is running on port ${DEFAULT_PORT} (PID file missing)`);
      return;
    }
  }

  if (info !== null) {
    console.log("Gateway is not running (stale PID file)");
  } else {
    console.log("Gateway is not running");
  }
}

async function showPairInfo(pidDir: string): Promise<void> {
  let key: Buffer;
  try {
    key = readFileSync(join(pidDir, "key"));
    if (key.length !== 32) throw new Error("bad length");
  } catch {
    console.log("Gateway has not been started yet. Run 'mypilot gateway' first.");
    process.exit(1);
  }

  const lanIP = detectLanIP();
  const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
  console.log(`MyPilot Gateway pairing info:`);
  displayConnectionInfo(lanIP, DEFAULT_PORT, key, links);
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

function handleLinkCommand(pidDir: string, args: string[]): void {
  const subCommand = args[0];
  const lanIP = detectLanIP();
  if (!subCommand || subCommand === 'list') {
    const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
    if (links.length === 0) {
      console.log('No links configured.');
      return;
    }
    console.log('');
    console.log('Configured Links:');
    for (const link of links) {
      const status = link.enabled ? 'enabled' : 'disabled';
      const active = link.id === 'lan-default' ? ' (default)' : '';
      console.log(`  ${link.id}  [${link.type}] ${link.label}: ${link.url} (${status}${active})`);
    }
    console.log('');
    return;
  }

  if (subCommand === 'add') {
    const type = args[1];
    const url = args[2];
    if (!type || !url) {
      console.error('Usage: mypilot link add <type> <url> [--label <label>]');
      process.exit(1);
    }
    if (!VALID_LINK_TYPES.includes(type as LinkType)) {
      console.error(`Invalid type: ${type}. Valid types: ${VALID_LINK_TYPES.join(', ')}`);
      process.exit(1);
    }
    const labelIdx = args.indexOf('--label');
    const label = labelIdx !== -1 && args[labelIdx + 1] ? args[labelIdx + 1]! : type;
    const id = `${type}-${Date.now()}`;
    const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
    links.push({ id, type: type as LinkType, label, url, enabled: true });
    saveLinksConfig(pidDir, links);
    console.log(`Added link: [${type}] ${label} (${url}) id=${id}`);
    return;
  }

  if (subCommand === 'remove') {
    const id = args[1];
    if (!id) {
      console.error('Usage: mypilot link remove <id>');
      process.exit(1);
    }
    const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
    const idx = links.findIndex(l => l.id === id);
    if (idx === -1) {
      console.error(`Link not found: ${id}`);
      process.exit(1);
    }
    const removed = links.splice(idx, 1)[0];
    saveLinksConfig(pidDir, links);
    console.log(`Removed link: ${removed.label}`);
    return;
  }

  if (subCommand === 'enable' || subCommand === 'disable') {
    const id = args[1];
    if (!id) {
      console.error(`Usage: mypilot link ${subCommand} <id>`);
      process.exit(1);
    }
    const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
    const link = links.find(l => l.id === id);
    if (!link) {
      console.error(`Link not found: ${id}`);
      process.exit(1);
    }
    const newState = subCommand === 'enable';
    if (link.enabled === newState) {
      console.log(`Already ${newState ? 'enabled' : 'disabled'}: ${link.label}`);
      return;
    }
    link.enabled = newState;
    saveLinksConfig(pidDir, links);
    console.log(`${newState ? 'Enabled' : 'Disabled'}: ${link.label}`);
    return;
  }

  console.error(`Unknown link sub-command: ${subCommand}`);
  process.exit(1);
}

async function handlePushCommand(pidDir: string, args: string[]): Promise<void> {
  const subCommand = args[0];

  if (!subCommand || subCommand === 'status') {
    const config = loadPushConfig(pidDir);
    if (config) {
      console.log('');
      console.log('Push notifications: enabled');
      console.log(`  Relay URL: ${config.relayUrl}`);
      console.log(`  Gateway ID: ${config.gatewayId}`);
      console.log('');

      const userInfo = await getUserInfo(config.relayUrl, config.apiKey);
      if (userInfo) {
        if (userInfo.email) {
          console.log(`  Account: ${userInfo.email}`);
        } else if (userInfo.gatewayId) {
          console.log(`  Account: ${userInfo.gatewayId} (auto-registered)`);
        }
        console.log(`  Plan: ${userInfo.plan}`);
        console.log(`  Today: ${userInfo.todayCount}/${userInfo.pushLimit} pushes`);
        console.log(`  Total: ${userInfo.pushCount} pushes`);
        console.log('');
      }
    } else {
      console.log('');
      console.log('Push notifications: disabled');
      console.log('');
      console.log('Start the gateway to auto-register push notifications.');
      console.log('');
    }
    return;
  }

  if (subCommand === 'setup') {
    const relayUrl = args[1];
    const apiKey = args[2];

    if (!relayUrl || !apiKey) {
      console.error('Usage: mypilot push setup <relay-url> <api-key>');
      process.exit(1);
    }

    const gatewayId = generateGatewayId(pidDir);
    savePushConfig(pidDir, { relayUrl, apiKey, gatewayId });

    console.log('Push notifications configured successfully.');
    console.log(`  Relay URL: ${relayUrl}`);
    console.log(`  Gateway ID: ${gatewayId}`);
    console.log('');
    console.log('Restart the gateway to apply changes.');
    return;
  }

  if (subCommand === 'disable') {
    deletePushConfig(pidDir);
    console.log('Push notifications disabled.');
    console.log('Restart the gateway to apply changes.');
    return;
  }

  console.error(`Unknown push sub-command: ${subCommand}`);
  process.exit(1);
}

function printSessionUsage(): void {
  console.log("Usage: mypilot session [options]");
  console.log("");
  console.log("Create, resume, or manage Claude Code sessions.");
  console.log("");
  console.log("Options:");
  console.log("  --help, -h          Show this help message");
  console.log("  --name <name>       Set display name for new session");
  console.log("  --cwd <path>        Set working directory (default: current directory)");
  console.log("  --model <model>     Set model for new session");
  console.log("  --resume <id>       Resume an existing session by name or ID prefix");
  console.log("  --continue          Resume the most recent session");
  console.log("");
  console.log("Commands:");
  console.log("  kill <id>           Kill a session");
  console.log("  ls [-w|--watch]     List all active sessions");
  console.log("");
  console.log("Examples:");
  console.log("  mypilot session                        Create a new session");
  console.log("  mypilot session --name my-project      Create a named session");
  console.log("  mypilot session --continue             Resume the most recent session");
  console.log("  mypilot session --resume abc123        Resume session abc123");
  console.log("  mypilot session kill abc123            Kill a session");
  console.log("  mypilot session ls                     List all sessions");
  console.log("  mypilot session ls -w                  Watch sessions live");
}

async function requireGateway(pidDir: string): Promise<Buffer> {
  const key = getOrCreateKeySafe(pidDir);
  if (!key) {
    console.error("Gateway has not been started yet. Run 'mypilot gateway' first.");
    process.exit(1);
  }
  const isExisting = await checkExistingGateway(DEFAULT_PORT, key);
  if (!isExisting) {
    console.error(`Gateway is not running or not responding correctly on port ${DEFAULT_PORT}. Check gateway status.`);
    process.exit(1);
  }
  return key;
}

async function handleSessionCommand(pidDir: string, args: string[]): Promise<void> {
  if (args.length >= 1) {
    const subcommand = args[0]!;

    if (subcommand === '--help' || subcommand === '-h') {
      printSessionUsage();
      process.exit(0);
    }

    if (subcommand === 'ls') {
      if (args.includes('--help') || args.includes('-h')) {
        printSessionUsage();
        process.exit(0);
      }
      const key = await requireGateway(pidDir);
      const watch = args.includes('-w') || args.includes('--watch');
      if (watch) {
        await watchSessionList(DEFAULT_PORT, key);
      } else {
        await printSessionList(DEFAULT_PORT, key);
      }
      return;
    }

    if (subcommand === 'kill') {
      if (!args[1]) {
        console.error("Usage: mypilot session kill <name-or-id>");
        process.exit(1);
      }
      const key = await requireGateway(pidDir);
      await killSession(DEFAULT_PORT, key, args[1]);
      return;
    }
  }

  const key = await requireGateway(pidDir);

  type SessionAction = 'new' | 'resume' | 'continue';
  let action: SessionAction = 'new';
  let sessionTarget: string | undefined;
  let sessionName: string | undefined;
  let sessionCwd: string | undefined;
  let sessionModel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--name':
        sessionName = args[++i];
        break;
      case '--cwd':
        sessionCwd = args[++i];
        break;
      case '--model':
        sessionModel = args[++i];
        break;
      case '--resume':
        action = 'resume';
        sessionTarget = args[++i];
        break;
      case '--continue':
        action = 'continue';
        break;
      default:
        if (!arg.startsWith('--')) {
          // 位置参数：当作 resume target
          action = 'resume';
          sessionTarget = arg;
        }
        break;
    }
  }

  const params = new URLSearchParams();
  if (action === 'new') {
    params.set('sessionId', 'new');
  } else if (action === 'continue') {
    params.set('sessionId', 'last');
  } else {
    params.set('sessionId', sessionTarget ?? 'new');
  }
  if (sessionName) params.set('name', sessionName);
  params.set('cwd', sessionCwd ?? process.cwd());
  if (sessionModel) params.set('model', sessionModel);

  const relayUrl = `ws://127.0.0.1:${DEFAULT_PORT}/pty-relay?${params.toString()}`;
  await runPtyRelayClient(relayUrl);
}

function formatSessionTable(sessions: SessionListEntry[]): string {
  const lines: string[] = [];
  lines.push("ID             名称           模式       来源");
  lines.push("─".repeat(80));
  for (const s of sessions) {
    const id = s.sessionId.slice(0, 8);
    const name = (s.displayName ?? '-').slice(0, 12);
    const mode = s.mode === 'pty' ? 'PTY' : 'headless';
    const source = s.source ?? '-';
    lines.push(`${id.padEnd(14)} ${name.padEnd(12)} ${mode.padEnd(8)} ${source}`);
  }
  return lines.join("\n");
}

async function printSessionList(port: number, key: Buffer): Promise<void> {
  const sessions = await fetchSessionList(port, key);
  if (!sessions || sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }
  console.log(formatSessionTable(sessions));
}

async function watchSessionList(port: number, key: Buffer): Promise<void> {
  const { stdout, stdin } = process;

  if (stdin.isTTY && stdin.isRaw) {
    stdin.setRawMode(false);
  }

  let tick = 0;
  let rendering = false;
  let lastData = '';

  const render = async () => {
    let sessions;
    try {
      sessions = await fetchSessionList(port, key);
    } catch {
      lastData = '';
      stdout.write("\x1b[2J\x1b[H");
      stdout.write(`Sessions (Ctrl+C to exit, refresh #${++tick})\n\n`);
      stdout.write("Failed to fetch sessions.\n");
      return;
    }
    const formatted = !sessions || sessions.length === 0
      ? "No active sessions.\n"
      : formatSessionTable(sessions) + "\n";
    if (formatted === lastData) return;
    lastData = formatted;
    stdout.write("\x1b[2J\x1b[H");
    stdout.write(`Sessions (Ctrl+C to exit, refresh #${++tick})\n\n`);
    stdout.write(formatted);
  };

  let timeout: NodeJS.Timeout;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    if (!rendering) {
      rendering = true;
      try {
        await render();
      } finally {
        rendering = false;
      }
    }
    timeout = setTimeout(poll, 5000);
  };

  await poll();

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      stopped = true;
      clearTimeout(timeout);
      process.removeListener('SIGINT', cleanup);
      process.removeListener('SIGTERM', cleanup);
      if (stdin.isTTY && stdin.isRaw) {
        stdin.setRawMode(false);
      }
      stdout.write("\n");
      resolve();
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

async function killSession(port: number, key: Buffer, target: string): Promise<void> {
  const sessions = await fetchSessionList(port, key);
  if (!sessions || sessions.length === 0) {
    console.error("Error: no active sessions.");
    process.exit(1);
  }
  let fullId: string | null = null;
  const prefixMatches: string[] = [];
  let nameMatch: string | undefined;
  for (const s of sessions) {
    if (s.sessionId === target) {
      fullId = s.sessionId;
      break;
    }
    if (s.sessionId.startsWith(target)) {
      prefixMatches.push(s.sessionId);
    }
    if (s.displayName === target) {
      nameMatch = s.sessionId;
    }
  }
  if (!fullId && prefixMatches.length === 1) {
    fullId = prefixMatches[0];
  }
  if (!fullId && nameMatch) {
    fullId = nameMatch;
  }
  if (!fullId) {
    console.error("Error: session '%s' not found.", target);
    process.exit(1);
  }
  await sendKillCommand(port, key, fullId);
  console.log("Session %s killed.", target);
}

interface SessionListEntry {
  sessionId: string;
  mode: string;
  displayName?: string;
  source?: string;
}

async function fetchSessionList(port: number, key: Buffer): Promise<SessionListEntry[] | null> {
  return new Promise((resolve) => {
    const req = get(
      `http://localhost:${port}/sessions?key=${encodeURIComponent(key.toString('base64'))}`,
      { timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function sendKillCommand(port: number, key: Buffer, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws-gateway?key=${encodeURIComponent(key.toString('base64'))}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout sending kill command"));
    }, 5000);

    ws.on('open', () => {
      ws.send(encrypt(key, JSON.stringify({ type: 'stop_session', sessionId })));
      clearTimeout(timer);
      ws.close();
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runPtyRelayClient(url: string): Promise<void> {
  const { stdin, stdout, exit } = process;

  if (!stdin.isTTY) {
    console.error("Error: session command requires a TTY terminal.");
    process.exit(1);
  }

  const ws = new WebSocket(url);
  let wsReady = false;

  function restoreTerminal(): void {
    if (stdin.isTTY && stdin.isRaw) {
      stdin.setRawMode(false);
    }
  }

  let onResize: (() => void) | undefined;

  function cleanup(): void {
    restoreTerminal();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('exit', restoreTerminal);
    if (onResize) process.removeListener('SIGWINCH', onResize);
    if (stdin.isTTY) {
      stdin.destroy();
    }
  }

  function onSigint(): void {
    if (wsReady && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'pty_detach' }));
      } catch { /* ignore */ }
    }
    cleanup();
    exit(0);
  }

  function onSigterm(): void {
    cleanup();
    exit(0);
  }

  process.on('exit', restoreTerminal);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      wsReady = true;

      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdin.setEncoding('utf8');

      stdin.on('data', (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'pty_in', data }));
          } catch { /* ignore */ }
        }
      });

      onResize = () => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'pty_resize',
              cols: stdout.columns,
              rows: stdout.rows,
            }));
          } catch { /* ignore */ }
        }
      };
      process.on('SIGWINCH', onResize);
      onResize();
    });

    ws.on('message', (raw) => {
      let msg: PtyRelayServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'pty_out':
          if (msg.data) {
            stdout.write(msg.data);
          }
          break;
        case 'pty_ready':
          console.log('Session ready: %s', msg.sessionId);
          break;
        case 'session_detached':
          console.log('\nSession detached. Gateway continues running.');
          cleanup();
          ws.close();
          exit(0);
          break;
        case 'session_end':
          console.log('\nSession ended.');
          cleanup();
          ws.close();
          exit(0);
          break;
        case 'pty_error':
          console.error('Error: %s', msg.message ?? 'Unknown error');
          cleanup();
          ws.close();
          exit(1);
          break;
      }
    });

    ws.on('close', () => {
      cleanup();
      exit(0);
    });

    ws.on('error', (err) => {
      cleanup();
      exit(1);
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

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case "start":
      await startBackground(pidDir, pidPath);
      break;
    case "stop":
      await stopGateway(pidDir, pidPath);
      break;
    case "restart":
      await stopGateway(pidDir, pidPath);
      await startBackground(pidDir, pidPath);
      break;
    case "gateway":
      await startGateway(pidDir, pidPath);
      break;
    case "status":
      await checkStatus(pidDir, pidPath);
      break;
    case "pair-info":
      await showPairInfo(pidDir);
      break;
    case "init-hooks":
      await initHooks(settingsPath);
      break;
    case "link":
      handleLinkCommand(pidDir, argv.slice(3));
      break;
    case "push":
      await handlePushCommand(pidDir, argv.slice(3));
      break;
    case "session":
      await handleSessionCommand(pidDir, argv.slice(3));
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

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
