import {
  ACCOUNT_NAMES,
  accountStatus,
  type ClaudeAccountName,
} from "./claude-account-env.mjs";

/** Provider identity only. Credentials are read by the spawner, never pooled. */
export interface ClaudeAccount {
  alias: ClaudeAccountName;
}

export function claudeAccountForProvider(provider = "claude-1"): ClaudeAccount {
  return { alias: provider === "claude-2" ? "claude-2" : "claude-1" };
}

export function claudeAccountsStatus(): string {
  return [
    ...ACCOUNT_NAMES.map(accountStatus),
    "pi-claude-cli: alias of claude-1",
  ].join("\n");
}
