import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/process-manager", () => ({
  validateCliPresence: vi.fn(),
  validateCliAuth: vi.fn(),
  killAllProcesses: vi.fn(),
}));
vi.mock("../src/provider", () => ({
  streamViaCli: vi.fn(),
  cliRequestsActive: vi.fn(() => false),
}));
vi.mock("../src/cli-process", () => ({
  retireAllCliProcesses: vi.fn(),
  parkedCliProcessesBusy: vi.fn(() => false),
}));
vi.mock("../src/handoff-broker", () => ({
  startHandoffBroker: vi.fn(async () => "socket"),
  stopHandoffBroker: vi.fn(),
}));
vi.mock("../src/mcp-config", () => ({
  getCustomToolDefs: vi.fn(),
  writeSchemaFile: vi.fn(() => ({
    schemaPath: "schema",
    version: 1,
    changed: false,
  })),
  cleanupMcpConfigFiles: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  registerApiProvider: vi.fn(),
}));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModels: () => [],
}));
import register from "../index";
import { streamViaCli } from "../src/provider";
import { retireAllCliProcesses } from "../src/cli-process";
import { writeSchemaFile } from "../src/mcp-config";
import { cliRequestsActive } from "../src/provider";
import { parkedCliProcessesBusy } from "../src/cli-process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PI_CLAUDE_CLI_CONTEXT;
});

describe("pi ownership at registration", () => {
  it("never activates tools and advertises exactly the request's current tools, including none", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => handlers.set(event, fn),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
      setActiveTools: vi.fn(),
      getAllTools: vi.fn(),
    };
    register(pi as any);
    const setStatus = vi.fn();
    await handlers.get("session_start")({}, { ui: { setStatus } });
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    const stream = pi.registerProvider.mock.calls[0][1].streamSimple;
    const tool = {
      name: "read",
      description: "pi read",
      parameters: { type: "object" },
    };
    stream({}, { systemPrompt: "pi", messages: [], tools: [tool] }, {});
    expect(writeSchemaFile).toHaveBeenLastCalledWith([
      { name: "read", description: "pi read", inputSchema: tool.parameters },
    ]);
    stream({}, { systemPrompt: "pi", messages: [], tools: [] }, {});
    expect(writeSchemaFile).toHaveBeenLastCalledWith([]);
    expect(pi.getAllTools).not.toHaveBeenCalled();
    expect(streamViaCli).toHaveBeenCalledTimes(2);
    for (const event of [
      "model_select",
      "session_tree",
      "session_compact",
      "session_shutdown",
    ]) {
      await handlers.get(event)();
    }
    expect(retireAllCliProcesses).toHaveBeenCalledTimes(5);
    expect(setStatus).toHaveBeenCalledWith("claude-rate-limit", undefined);
    expect(setStatus).toHaveBeenCalledWith("claude-subagents", undefined);
  });
  it("dispatches plain manual commands, blocks busy switches, clears quota and captures the selected profile per request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-command-"));
    const profile = join(dir, "second");
    mkdirSync(profile);
    const map = join(dir, "accounts.json");
    writeFileSync(map, JSON.stringify({ account2: profile }));
    vi.stubEnv("PI_CLAUDE_CLI_ACCOUNTS_FILE", map);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    const handlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => handlers.set(event, fn),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
    };
    const ctx = {
      isIdle: vi.fn(() => true),
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };
    try {
      register(pi as any);
      await handlers.get("session_start")({}, ctx);
      const command = pi.registerCommand.mock.calls.find(
        ([name]) => name === "claude-account",
      )![1].handler;
      const stream = pi.registerProvider.mock.calls[0][1].streamSimple;
      await command("status", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("account1"),
        "info",
      );
      await command("list", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining(`account2: ${profile}`),
        "info",
      );
      ctx.isIdle.mockReturnValue(false);
      await command("select account2", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("idle"),
        "warning",
      );
      ctx.isIdle.mockReturnValue(true);
      vi.mocked(cliRequestsActive).mockReturnValue(true);
      await command("account2", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("idle"),
        "warning",
      );
      vi.mocked(cliRequestsActive).mockReturnValue(false);
      vi.mocked(parkedCliProcessesBusy).mockReturnValue(true);
      await command("account2", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("idle"),
        "warning",
      );
      vi.mocked(parkedCliProcessesBusy).mockReturnValue(false);
      stream({}, { messages: [], tools: [] });
      const firstOptions = vi.mocked(streamViaCli).mock.calls.at(-1)![2]!;
      firstOptions.onRateLimit?.({ status: "rejected", resetsAt: 999 });
      expect(JSON.parse(ctx.ui.setStatus.mock.calls.at(-1)![1]!)).toMatchObject(
        { account: "account1", status: "rejected" },
      );
      const retireCount = vi.mocked(retireAllCliProcesses).mock.calls.length;
      await command("account2", ctx);
      expect(retireAllCliProcesses).toHaveBeenCalledTimes(retireCount + 1);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "claude-rate-limit",
        undefined,
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "claude-account",
        "account2",
      );
      stream({}, { messages: [], tools: [] });
      const secondOptions = vi.mocked(streamViaCli).mock.calls.at(-1)![2]!;
      expect(secondOptions.account).toEqual({
        alias: "account2",
        configDir: profile,
      });
      expect(firstOptions.account?.alias).toBe("account1");
      secondOptions.onRateLimit?.({ status: "rejected", resetsAt: 999 });
      expect(JSON.parse(ctx.ui.setStatus.mock.calls.at(-1)![1]!)).toMatchObject(
        { account: "account2" },
      );
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "legacy");
      await command("account1", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("not legacy"),
        "warning",
      );
      vi.stubEnv("PI_CLAUDE_CLI_CONTEXT", "pi");
      await command("select account1", ctx);
      stream({}, { messages: [], tools: [] });
      expect(vi.mocked(streamViaCli).mock.calls.at(-1)![2]!.account).toEqual({
        alias: "account1",
        configDir: undefined,
      });
      await command("account2", ctx);
      await handlers.get("session_start")({}, ctx);
      stream({}, { messages: [], tools: [] });
      expect(
        vi.mocked(streamViaCli).mock.calls.at(-1)![2]!.account?.alias,
      ).toBe("account1");
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
