#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, realpathSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createServer } from "./gateway/server.js";
import { getOrCreateKey, detectLanIP } from "./gateway/token-store.js";
import { displayConnectionInfo } from "./gateway/qr-display.js";
import { mergeHooksIntoSettings, buildHooksConfig } from "./gateway/hooks-config.js";
import { loadLinksConfig, saveLinksConfig } from "./gateway/link-config.js";
import { loadPushConfig, savePushConfig, deletePushConfig, generateGatewayId, registerAccount, getUserInfo } from "./gateway/push-config.js";
import { VALID_LINK_TYPES, type LinkType } from "../shared/protocol.js";

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

function printUsage(): void {
  console.log("Usage: mypilot <command>");
  console.log("");
  console.log("Commands:");
  console.log("  start       Start Gateway in background");
  console.log("  stop        Stop background Gateway");
  console.log("  restart     Restart Gateway (stop + start)");
  console.log("  gateway     Start Gateway in foreground");
  console.log("  status      Check Gateway status");
  console.log("  pair-info   Show pairing info (IP + QR code)");
  console.log("  init-hooks  Configure Claude Code hooks");
  console.log("  link        Manage communication links");
  console.log("              link list");
  console.log("              link add <lan|tunnel> <url> [--label <label>]");
  console.log("              link remove <id>");
  console.log("              link enable <id>");
  console.log("              link disable <id>");
  console.log("  push        Manage push notification config");
  console.log("              push status");
  console.log("              push register <email> [--relay <url>]");
  console.log("              push setup <relay-url> <api-key>");
  console.log("              push disable");
}

async function startGateway(pidDir: string, pidPath: string): Promise<void> {
  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid.pid, existingPid.startTime)) {
    console.error(`Gateway is already running (PID ${existingPid.pid})`);
    process.exit(1);
  }

  mkdirSync(pidDir, { recursive: true });
  const key = getOrCreateKey(pidDir);
  const logDir = join(pidDir, "logs");

  const lanIP = detectLanIP();
  const links = loadLinksConfig(pidDir, lanIP, DEFAULT_PORT);
  const pushConfig = loadPushConfig(pidDir);

  const server = createServer(DEFAULT_PORT, logDir, pidDir, key, pushConfig ?? undefined);


  writePidFile(pidPath, process.pid);

  await server.start();

  console.log(`Gateway running at http://localhost:${DEFAULT_PORT}`);
  if (pushConfig) {
    console.log(`Push notifications enabled (relay: ${pushConfig.relayUrl})`);
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
  const url = import.meta.url;
  const filePath = url.startsWith("file://") ? decodeURIComponent(new URL(url).pathname) : url;
  return filePath;
}

async function startBackground(pidDir: string, pidPath: string): Promise<void> {
  const existingPid = readPidFile(pidPath);
  if (existingPid !== null && isProcessAlive(existingPid.pid, existingPid.startTime)) {
    console.error(`Gateway is already running (PID ${existingPid.pid})`);
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

async function stopGateway(pidPath: string): Promise<void> {
  const info = readPidFile(pidPath);

  if (info === null) {
    console.log("Gateway is not running");
    return;
  }

  if (!isProcessAlive(info.pid, info.startTime)) {
    try {
      unlinkSync(pidPath);
    } catch {
      // ignore
    }
    console.log("Gateway is not running (cleaned up stale PID file)");
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

async function checkStatus(pidPath: string): Promise<void> {
  const info = readPidFile(pidPath);

  if (info === null) {
    console.log("Gateway is not running");
    return;
  }

  if (!isProcessAlive(info.pid, info.startTime)) {
    console.log("Gateway is not running (stale PID file)");
    return;
  }

  console.log(`Gateway is running (PID ${info.pid}, port ${DEFAULT_PORT})`);
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
        console.log(`  Account: ${userInfo.email}`);
        console.log(`  Plan: ${userInfo.plan}`);
        console.log(`  Today: ${userInfo.todayCount}/${userInfo.pushLimit} pushes`);
        console.log(`  Total: ${userInfo.pushCount} pushes`);
        console.log('');
      }
    } else {
      console.log('');
      console.log('Push notifications: disabled');
      console.log('');
      console.log('To enable, run:');
      console.log('  mypilot push register <email>');
      console.log('');
    }
    return;
  }

  if (subCommand === 'register') {
    const email = args[1];
    const relayIdx = args.indexOf('--relay');
    const relayUrl = relayIdx !== -1 && args[relayIdx + 1] ? args[relayIdx + 1] : 'https://push.mypilot.dev';

    if (!email) {
      console.error('Usage: mypilot push register <email> [--relay <url>]');
      process.exit(1);
    }

    console.log(`Registering account: ${email}`);
    console.log(`Relay URL: ${relayUrl}`);
    console.log('');

    const result = await registerAccount(relayUrl, email);
    if (!result) {
      console.error('Registration failed. Please check the relay URL and try again.');
      process.exit(1);
    }

    const gatewayId = generateGatewayId(pidDir);
    savePushConfig(pidDir, { relayUrl, apiKey: result.apiKey, gatewayId });

    console.log('Registration successful!');
    console.log(`  API Key: ${result.apiKey}`);
    console.log(`  Plan: ${result.plan}`);
    console.log(`  Push Limit: ${result.pushLimit}/day`);
    console.log(`  Gateway ID: ${gatewayId}`);
    console.log('');
    console.log('Restart the gateway to apply changes.');
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
    case "restart":
      await stopGateway(pidPath);
      await startBackground(pidDir, pidPath);
      break;
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
    case "link":
      handleLinkCommand(pidDir, argv.slice(3));
      break;
    case "push":
      await handlePushCommand(pidDir, argv.slice(3));
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
