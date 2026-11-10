/**
 * Drop this extension's own knobs before any test runs.
 *
 * Every `PI_CLAUDE_CLI_*` variable changes what the provider does, and the
 * most likely place to run these tests is a session that is ITSELF driven by
 * this extension — a Phosphor Claude session exports `PI_CLAUDE_CLI_CONTEXT=pi`,
 * `PI_CLAUDE_CLI_STRICT_MCP=1` and `PI_CLAUDE_CLI_AUTOCOMPACT` into every
 * shell it spawns. Inherited, `PI_CLAUDE_CLI_CONTEXT=pi` alone made 125 tests
 * fail: `spawnClaude` shells out to `claude --version` under that policy, so
 * the mocked spawn was never reached, and the failures looked exactly like a
 * regression on main.
 *
 * Tests that need a knob set it themselves (and restore it), so clearing the
 * environment here can only remove ambient state.
 */
import { beforeEach } from "vitest";

import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never read a developer's real provider-account files in deterministic tests.
const accountTestDir = mkdtempSync(join(tmpdir(), "pcc-test-accounts-"));
process.env.PI_CODING_AGENT_DIR = accountTestDir;
afterAll(() => rmSync(accountTestDir, { recursive: true, force: true }));
// Existing observer-mode fixtures exercise the explicitly supported legacy path.
// Pi-owned suites unset this in their own beforeEach to test the real default.
beforeEach(() => {
  process.env.PI_CLAUDE_CLI_CONTEXT = "legacy";
});

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_CLAUDE_CLI_")) delete process.env[key];
}
