import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Only profile locations, never credentials. Undefined preserves the CLI's default. */
export interface ClaudeAccount {
  alias: string;
  configDir?: string;
}

const AUTH_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

export function accountOverrideNames(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return AUTH_OVERRIDES.filter((name) => !!env[name]);
}

export function assertAccountEnvironment(account: ClaudeAccount): void {
  if (account.alias === "account1") return;
  assertNoOverrides();
}

function assertNoOverrides(): void {
  const names = accountOverrideNames();
  if (names.length) {
    throw new Error(
      `Cannot switch Claude profiles while authentication overrides are set: ${names.join(", ")}. No environment values were changed.`,
    );
  }
}

export function defaultClaudeAccount(): ClaudeAccount {
  return { alias: "account1", configDir: process.env.CLAUDE_CONFIG_DIR };
}

/** Includes the inherited keychain location without reading its contents. */
export function claudeAccountIdentity(account: ClaudeAccount): string {
  return JSON.stringify([
    account.alias,
    account.configDir ?? null,
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,
  ]);
}

export function claudeAccountsFile(): string {
  return (
    process.env.PI_CLAUDE_CLI_ACCOUNTS_FILE ??
    join(
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      "claude-accounts.json",
    )
  );
}

function configuredAccounts(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(claudeAccountsFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read Claude profile map.");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    for (const [alias, path] of Object.entries(parsed)) {
      if (
        !/^[a-z][a-z0-9_-]{0,31}$/.test(alias) ||
        alias === "account1" ||
        typeof path !== "string" ||
        !isAbsolute(path)
      )
        throw new Error();
    }
    return parsed as Record<string, string>;
  } catch {
    throw new Error(
      "Invalid Claude profile map: use an object of aliases to absolute directory paths; account1 is reserved.",
    );
  }
}

/** One extension runtime/session owns this selection; it is never exported via process.env. */
export class ClaudeAccounts {
  private readonly original = defaultClaudeAccount();
  private selected = this.original;

  current(): ClaudeAccount {
    return { ...this.selected };
  }

  reset(): void {
    this.selected = this.original;
  }

  status(): string {
    const overrides = accountOverrideNames();
    return `Claude profile: ${this.selected.alias} (${this.selected.configDir ?? "CLI default; CLAUDE_CONFIG_DIR unset"})${overrides.length ? `\nAuthentication overrides present: ${overrides.join(", ")}; profile switching blocked.` : ""}`;
  }

  list(): string {
    return [
      this.status(),
      `account1: ${this.original.configDir ?? "inherited CLI default"}`,
      ...Object.entries(configuredAccounts()).map(
        ([alias, path]) => `${alias}: ${path}`,
      ),
    ].join("\n");
  }

  select(alias: string, idle: boolean): boolean {
    if (!idle)
      throw new Error(
        "Claude profile unchanged: wait until Pi is idle (including tools and retries), or cancel the run first.",
      );
    if (alias === this.selected.alias) return false;
    assertNoOverrides();
    let next = this.original;
    if (alias !== "account1") {
      const profiles = configuredAccounts();
      const path = profiles[alias];
      if (!Object.hasOwn(profiles, alias) || !path)
        throw new Error("Unknown Claude profile. Use /claude-account list.");
      try {
        if (!statSync(path).isDirectory()) throw new Error();
        accessSync(path, constants.R_OK | constants.X_OK);
        next = { alias, configDir: realpathSync(path) };
      } catch {
        throw new Error(
          "Claude profile directory is unavailable; selection unchanged.",
        );
      }
    }
    this.selected = next;
    return true;
  }
}
