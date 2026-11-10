import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-wrappers-"));
  mkdirSync(join(dir, "source"));
  mkdirSync(join(dir, "agent", "claude-accounts"), { recursive: true });
  const real = join(dir, "source", "claude");
  writeFileSync(
    real,
    `#!${process.execPath}\nconst crypto = require('node:crypto'); console.log(JSON.stringify({tokenHash: crypto.createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').digest('hex'), configDir: process.env.CLAUDE_CONFIG_DIR, args: process.argv.slice(2)}));\n`,
    { mode: 0o755 },
  );
  env = {
    ...process.env,
    PATH: join(dir, "source"),
    HOME: dir,
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    CLAUDE_CODE_OAUTH_TOKEN: "inherited-secret",
    CLAUDE_CONFIG_DIR: "/inherited",
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const install = (extra: string[] = []) =>
  spawnSync(
    process.execPath,
    [
      resolve("scripts/install-claude-wrappers.mjs"),
      "--bin-dir",
      join(dir, "bin"),
      ...extra,
    ],
    { env, encoding: "utf8" },
  );
const run = (name: string, args: string[] = []) =>
  spawnSync(join(dir, "bin", name), args, { env, encoding: "utf8" });
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const save = (value: unknown, name = "claude-2") =>
  writeFileSync(
    join(dir, "agent", "claude-accounts", `${name}.json`),
    JSON.stringify(value),
    { mode: 0o600 },
  );

describe.skipIf(process.platform === "win32")("Claude shell wrappers", () => {
  it("dry-run writes nothing and installation embeds paths, never credentials, with mode 0755", () => {
    save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "installed-secret" } });
    const dry = install(["--dry-run"]);
    expect(dry.status).toBe(0);
    expect(existsSync(join(dir, "bin"))).toBe(false);
    const installed = install();
    expect(installed.status).toBe(0);
    expect(installed.stdout + installed.stderr + dry.stdout).not.toContain(
      "installed-secret",
    );
    for (const name of ["claude-1", "claude-2"]) {
      const file = join(dir, "bin", name);
      expect(statSync(file).mode & 0o777).toBe(0o755);
      expect(readFileSync(file, "utf8")).not.toContain("installed-secret");
    }
    expect(install().status).toBe(1);
  });
  it("reads runtime files (including symlinks), quotes tokens safely and forwards CLI args", () => {
    expect(install().status).toBe(0);
    const target = join(dir, "dashboard.json");
    const token = `sentinel'$(touch ${join(dir, "injected")})`;
    writeFileSync(
      target,
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } }),
      { mode: 0o600 },
    );
    symlinkSync(target, join(dir, "agent", "claude-accounts", "claude-2.json"));
    const first = run("claude-2", ["--model", "some model"]);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      tokenHash: hash(token),
      args: ["--model", "some model"],
    });
    expect(existsSync(join(dir, "injected"))).toBe(false);
    expect(first.stdout + first.stderr).not.toContain(token);
    writeFileSync(
      target,
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "rotated-secret" } }),
    );
    expect(JSON.parse(run("claude-2").stdout).tokenHash).toBe(
      hash("rotated-secret"),
    );
    chmodSync(target, 0o644);
    const refused = run("claude-2");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("mode 0600");
    expect(refused.stdout + refused.stderr).not.toContain("rotated-secret");
  });
  it("clears inherited credentials for native claude-1, refuses missing/invalid claude-2, supports config directories", () => {
    expect(install().status).toBe(0);
    expect(JSON.parse(run("claude-1").stdout)).toEqual({
      tokenHash: hash(""),
      args: [],
    });
    expect(run("claude-2").stderr).toContain("claude-2: account file missing");
    save({ env: { BAD: "hidden-secret" } });
    expect(run("claude-2").status).toBe(1);
    expect(run("claude-2").stderr).not.toContain("hidden-secret");
    save({ env: { CLAUDE_CONFIG_DIR: dir } });
    expect(JSON.parse(run("claude-2").stdout)).toEqual({
      tokenHash: hash(""),
      configDir: dir,
      args: [],
    });
  });
  it("blocks conflicting inherited auth for configured wrappers without printing credentials", () => {
    expect(install().status).toBe(0);
    save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "configured-secret" } });
    env.ANTHROPIC_API_KEY = "inherited-api-secret";
    const refused = run("claude-2");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("ANTHROPIC_API_KEY");
    expect(refused.stdout + refused.stderr).not.toMatch(
      /configured-secret|inherited-api-secret/,
    );
    expect(run("claude-1").status).toBe(0);
  });
  it("refuses to resolve claude through an account-wrapper symlink", () => {
    rmSync(join(dir, "source", "claude"));
    const wrapper = join(dir, "source", "claude-1");
    writeFileSync(wrapper, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    symlinkSync(wrapper, join(dir, "source", "claude"));
    expect(install().status).toBe(1);
    expect(existsSync(join(dir, "bin"))).toBe(false);
  });
});
