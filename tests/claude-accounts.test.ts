import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  symlinkSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountFile, readAccountEnv } from "../src/claude-account-env.mjs";
import { claudeAccountsStatus } from "../src/claude-accounts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  mkdirSync(join(dir, "claude-accounts"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("HOME", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function save(value: unknown, name: "claude-1" | "claude-2" = "claude-2") {
  writeFileSync(accountFile(name), JSON.stringify(value), { mode: 0o600 });
}

describe("provider account files", () => {
  it("uses native login only for missing claude-1; missing claude-2 fails closed", () => {
    expect(readAccountEnv("claude-1").env).toEqual({});
    expect(() => readAccountEnv("claude-2")).toThrow(
      "claude-2: account file missing",
    );
    expect(claudeAccountsStatus()).toContain(
      "pi-claude-cli: alias of claude-1",
    );
  });

  it.skipIf(process.platform === "win32")(
    "follows symlinks and validates target mode; dangling claude-1 links never fall back",
    () => {
      const target = join(dir, "dashboard-account.json");
      writeFileSync(
        target,
        JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "symlink-secret" } }),
        { mode: 0o600 },
      );
      symlinkSync(target, accountFile("claude-2"));
      expect(readAccountEnv("claude-2").env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        "symlink-secret",
      );
      chmodSync(target, 0o644);
      expect(() => readAccountEnv("claude-2")).toThrow("mode 0600");
      symlinkSync(join(dir, "missing-target"), accountFile("claude-1"));
      expect(() => readAccountEnv("claude-1")).toThrow(
        "symlink target missing",
      );
      expect(claudeAccountsStatus()).not.toContain("symlink-secret");
    },
  );
  it.skipIf(process.platform === "win32").each([
    ["claude-1", false],
    ["claude-1", true],
    ["claude-2", false],
    ["claude-2", true],
  ] as const)(
    "validates config-dir-only %s target mode and ownership (symlink: %s)",
    (name, linked) => {
      const target = linked
        ? join(dir, "profile-account.json")
        : accountFile(name);
      const env = { CLAUDE_CONFIG_DIR: dir };
      writeFileSync(target, JSON.stringify({ env }), { mode: 0o600 });
      if (linked) symlinkSync(target, accountFile(name));
      expect(readAccountEnv(name).env).toEqual(env);
      for (const mode of [0o644, 0o640, 0o400, 0o1600]) {
        chmodSync(target, mode);
        expect(() => readAccountEnv(name)).toThrow("mode 0600");
      }
      chmodSync(target, 0o600);
      if (typeof process.getuid === "function") {
        const uid = process.getuid();
        const getuid = vi
          .spyOn(process as { getuid: () => number }, "getuid")
          .mockReturnValue(uid + 1);
        try {
          expect(() => readAccountEnv(name)).toThrow(
            "owned by the current user",
          );
        } finally {
          getuid.mockRestore();
        }
      }
      expect(readAccountEnv(name).env).toEqual(env);
    },
  );
  it.skipIf(typeof process.getuid !== "function")(
    "refuses token files owned by another user",
    () => {
      save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "owner-secret" } });
      const uid = process.getuid!();
      const getuid = vi
        .spyOn(process as { getuid: () => number }, "getuid")
        .mockReturnValue(uid + 1);
      try {
        expect(() => readAccountEnv("claude-2")).toThrow(
          "owned by the current user",
        );
        expect(claudeAccountsStatus()).not.toContain("owner-secret");
      } finally {
        getuid.mockRestore();
      }
    },
  );
  it("treats empty agent dir as unset", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    expect(accountFile("claude-1")).toBe(
      join(dir, ".pi", "agent", "claude-accounts", "claude-1.json"),
    );
  });
  it.each(["claude-1", "claude-2"] as const)(
    "fails closed on conflicting inherited auth for configured %s, with names only",
    (name) => {
      save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "file-secret" } }, name);
      vi.stubEnv("ANTHROPIC_API_KEY", "inherited-api-secret");
      expect(() => readAccountEnv(name)).toThrow("ANTHROPIC_API_KEY");
      expect(claudeAccountsStatus()).not.toMatch(
        /file-secret|inherited-api-secret/,
      );
      if (name === "claude-2")
        expect(readAccountEnv("claude-1").env).toEqual({});
    },
  );
  it("accepts a private token and never includes it in status", () => {
    save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-sentinel" } });
    expect(readAccountEnv("claude-2").env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "secret-sentinel",
    );
    expect(claudeAccountsStatus()).toContain("token present: yes");
    expect(claudeAccountsStatus()).not.toContain("secret-sentinel");
  });
  it.skipIf(process.platform === "win32")(
    "requires exactly 0600 for token files, without exposing credentials",
    () => {
      save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-sentinel" } });
      for (const mode of [0o644, 0o640, 0o400, 0o1600]) {
        chmodSync(accountFile("claude-2"), mode);
        expect(() => readAccountEnv("claude-2")).toThrow("mode 0600");
        expect(claudeAccountsStatus()).not.toContain("secret-sentinel");
      }
    },
  );
  it.each([
    {},
    { env: {} },
    { env: [] },
    { env: { OTHER_SECRET: "secret-sentinel" } },
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 123 } },
    { env: { CLAUDE_CODE_OAUTH_TOKEN: " " } },
    { env: { CLAUDE_CONFIG_DIR: "relative" } },
    { env: { CLAUDE_CONFIG_DIR: "/nonexistent/secret-sentinel" } },
    { env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-sentinel" }, extra: true },
  ])("rejects invalid config without echoing values: %#", (config) => {
    save(config);
    expect(() => readAccountEnv("claude-2")).toThrow("claude-2:");
    expect(claudeAccountsStatus()).not.toContain("secret-sentinel");
  });
  it("rejects malformed JSON and invalid claude-1 instead of silently using native", () => {
    writeFileSync(accountFile("claude-1"), "{secret-sentinel");
    expect(() => readAccountEnv("claude-1")).toThrow("invalid account JSON");
    expect(claudeAccountsStatus()).not.toContain("secret-sentinel");
  });
  it("accepts an absolute existing directory and reports a settings token without reading out its value", () => {
    const profile = join(dir, "profile");
    mkdirSync(profile);
    writeFileSync(
      join(profile, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "manual-secret" } }),
    );
    save({ env: { CLAUDE_CONFIG_DIR: profile } }, "claude-1");
    expect(readAccountEnv("claude-1").env.CLAUDE_CONFIG_DIR).toBe(profile);
    expect(claudeAccountsStatus()).toContain(
      "claude-1 follows manual default token from settings.json",
    );
    expect(claudeAccountsStatus()).not.toContain("manual-secret");
  });
  it("warns about a native manual-default settings token, but explicit token accounts take precedence", () => {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "manual-secret" } }),
    );
    expect(claudeAccountsStatus()).toContain(
      "claude-1 follows manual default token from settings.json",
    );
    save({ env: { CLAUDE_CODE_OAUTH_TOKEN: "explicit-secret" } }, "claude-1");
    expect(claudeAccountsStatus()).not.toContain("follows manual default");
    expect(claudeAccountsStatus()).not.toMatch(/manual-secret|explicit-secret/);
  });
});
