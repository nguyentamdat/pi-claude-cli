export type ClaudeAccountName = "claude-1" | "claude-2";
export const ACCOUNT_NAMES: readonly ClaudeAccountName[];
export function accountFile(name: ClaudeAccountName): string;
export function readAccountEnv(name: ClaudeAccountName): {
  env: { CLAUDE_CODE_OAUTH_TOKEN?: string; CLAUDE_CONFIG_DIR?: string };
  source: string;
};
export function accountStatus(name: ClaudeAccountName): string;
