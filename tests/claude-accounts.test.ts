import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeAccounts,
  accountOverrideNames,
  claudeAccountIdentity,
} from "../src/claude-accounts";

let dir: string;
let map: string;
let profile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  profile = join(dir, "second");
  mkdirSync(profile, { mode: 0o700 });
  map = join(dir, "profiles.json");
  writeFileSync(map, JSON.stringify({ account2: profile }));
  vi.stubEnv("PI_CLAUDE_CLI_ACCOUNTS_FILE", map);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  for (const name of accountOverrideNames()) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeAccounts session-local selection", () => {
  it("starts on the existing CLI default and never changes another runtime or the environment", () => {
    const one = new ClaudeAccounts();
    const other = new ClaudeAccounts();
    expect(one.current()).toEqual({ alias: "account1", configDir: undefined });
    expect(one.list()).toContain(`account2: ${profile}`);
    const before = { ...process.env };
    expect(one.select("account2", true)).toBe(true);
    expect(one.current()).toEqual({ alias: "account2", configDir: profile });
    expect(other.current().alias).toBe("account1");
    expect(process.env).toEqual(before);
    expect(one.select("account2", true)).toBe(false);
    expect(one.select("account1", true)).toBe(true);
    expect(one.current().configDir).toBeUndefined();
    one.select("account2", true);
    one.reset();
    expect(one.current().alias).toBe("account1");
  });

  it("preserves an explicit default and never reads or mutates account credentials", () => {
    const original = join(dir, "original");
    mkdirSync(original);
    const credential = join(original, ".credentials.json");
    writeFileSync(credential, "sentinel-not-a-real-credential");
    vi.stubEnv("CLAUDE_CONFIG_DIR", original);
    const accounts = new ClaudeAccounts();
    accounts.select("account2", true);
    accounts.select("account1", true);
    expect(accounts.current().configDir).toBe(original);
    expect(readFileSync(credential, "utf8")).toBe(
      "sentinel-not-a-real-credential",
    );
    expect(accounts.status()).not.toContain("sentinel");
  });

  it("rejects busy, unknown, inaccessible and invalid selections without changing the account", () => {
    const accounts = new ClaudeAccounts();
    expect(() => accounts.select("account2", false)).toThrow("idle");
    for (const alias of ["absent", "toString", "__proto__"])
      expect(() => accounts.select(alias, true)).toThrow("Unknown");
    writeFileSync(map, JSON.stringify({ account2: join(dir, "missing") }));
    expect(() => accounts.select("account2", true)).toThrow("unavailable");
    for (const value of [
      "invalid-sentinel",
      "[]",
      '{"account1":"/override"}',
      '{"account2":"relative"}',
      '{"account2":42}',
    ]) {
      writeFileSync(map, value);
      expect(() => accounts.list()).toThrow("Invalid Claude profile map");
    }
    expect(accounts.current().alias).toBe("account1");
    rmSync(map);
    expect(accounts.list()).toContain("account1");
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])(
    "rejects %s overrides but never logs their values or changes them",
    (name) => {
      vi.stubEnv(name, "secret-sentinel");
      const accounts = new ClaudeAccounts();
      expect(() => accounts.select("account2", true)).toThrow(name);
      expect(accounts.status()).toContain(name);
      expect(accounts.status()).not.toContain("secret-sentinel");
      expect(process.env[name]).toBe("secret-sentinel");
      expect(accounts.current().alias).toBe("account1");
    },
  );

  it("keys warm reuse by profile path even for the same alias", () => {
    expect(
      claudeAccountIdentity({ alias: "account2", configDir: "/a" }),
    ).not.toBe(claudeAccountIdentity({ alias: "account2", configDir: "/b" }));
    expect(claudeAccountIdentity({ alias: "account1" })).not.toBe(
      claudeAccountIdentity({ alias: "account2", configDir: "/b" }),
    );
  });
});
