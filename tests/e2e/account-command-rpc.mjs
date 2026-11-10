// Offline command-dispatch smoke through the installed Pi (including RPC UI).
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "claude-account-rpc-"));
const agent = join(work, "agent");
const bin = join(work, "bin");
const profile = join(work, "account2");
for (const path of [agent, bin, profile]) mkdirSync(path, { mode: 0o700 });
mkdirSync(join(agent, "claude-accounts"));
writeFileSync(
  join(agent, "claude-accounts", "claude-2.json"),
  JSON.stringify({ env: { CLAUDE_CONFIG_DIR: profile } }),
);
// Even if dispatch regresses, this fixture cannot contact a model or read auth.
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("9.9.9 (offline fixture)");
else if (args[0] === "auth" && args[1] === "status") console.log('{"loggedIn":true}');
else { console.error("Model inference forbidden in account-command smoke"); process.exit(90); }
`,
);
chmodSync(join(bin, "claude"), 0o700);
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agent,
  HOME: work,
  PI_OFFLINE: "1",
  PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
};
for (const key of [
  "CLAUDE_CONFIG_DIR",
  "PI_CLAUDE_CLI_CONTEXT",
  "PI_CLAUDE_CLI_ACCOUNTS_FILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
])
  delete env[key];
const child = spawn(
  "pi",
  ["--mode", "rpc", "-ne", "-e", root, "--no-session"],
  { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] },
);
const pending = new Map();
const notifications = [];
let sequence = 0;
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "response") {
    const resolve = pending.get(event.id);
    pending.delete(event.id);
    resolve?.(event);
  }
  if (event.type === "extension_ui_request" && event.method === "notify")
    notifications.push(event.message);
});
const closed = new Promise((resolve) => child.on("close", resolve));
function request(command) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("RPC command timed out (no inference requested)"));
    }, 15_000);
    pending.set(id, (event) => {
      clearTimeout(timeout);
      resolve(event);
    });
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
}
try {
  const available = await request({ type: "get_available_models" });
  assert.equal(available.success, true, "model catalog available");
  const idsFor = (provider) =>
    available.data.models
      .filter((model) => model.provider === provider)
      .map((model) => model.id)
      .sort();
  const aliasIds = idsFor("pi-claude-cli");
  assert.ok(aliasIds.length > 0, "compatibility alias models registered");
  assert.deepEqual(
    idsFor("claude-1"),
    aliasIds,
    "account1 model catalog matches alias",
  );
  assert.deepEqual(
    idsFor("claude-2"),
    aliasIds,
    "account2 model catalog matches alias",
  );
  const commands = await request({ type: "get_commands" });
  assert.equal(commands.success, true, "get_commands must succeed");
  assert.ok(
    commands.data.commands.some((command) => command.name === "claude-account"),
    "manual command registered",
  );
  for (const [message, expected] of [
    ["/claude-account status", "claude-1: native default login"],
    ["/claude-account list", "claude-2:"],
    ["/claude-account select claude-2", "Read-only command"],
    ["/claude-account status", "pi-claude-cli: alias of claude-1"],
  ]) {
    const start = notifications.length;
    const response = await request({ type: "prompt", message });
    assert.equal(response.success, true, "slash command handled");
    assert.ok(
      notifications.slice(start).some((text) => text.includes(expected)),
      "RPC notification confirms selection",
    );
  }
  const messages = await request({ type: "get_messages" });
  assert.deepEqual(
    messages.data.messages,
    [],
    "commands must never become model conversation",
  );
  console.log(
    "account-command RPC OK: read-only list/status; no model requests or auth writes",
  );
} catch (error) {
  // Never relay full CLI output/config; only report the test's own assertions.
  console.error(error.message);
  if (stderr.includes("Failed to register provider"))
    console.error("Provider registration failed in isolated RPC fixture");
  process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
  await closed;
  rmSync(work, { recursive: true, force: true });
}
