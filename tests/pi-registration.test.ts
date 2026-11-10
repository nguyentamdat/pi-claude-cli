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
  getBuiltinModels: () => [
    {
      id: "claude-test",
      name: "test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    },
  ],
}));
import register from "../index";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { streamViaCli } from "../src/provider";
import { retireAllCliProcesses } from "../src/cli-process";
import { writeSchemaFile } from "../src/mcp-config";
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
  it("registers both accounts and the compatibility alias with identical catalogs and distinct APIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-command-"));
    mkdirSync(join(dir, "claude-accounts"));
    writeFileSync(
      join(dir, "claude-accounts", "claude-2.json"),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "status-secret" } }),
      { mode: 0o600 },
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("HOME", dir);
    const handlers = new Map<string, any>();
    const pi = {
      on: (event: string, fn: any) => handlers.set(event, fn),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
    };
    const ctx = { ui: { setStatus: vi.fn(), notify: vi.fn() } };
    try {
      register(pi as any);
      expect(pi.registerProvider.mock.calls.map(([name]) => name)).toEqual([
        "pi-claude-cli",
        "claude-1",
        "claude-2",
      ]);
      expect(
        vi.mocked(registerApiProvider).mock.calls.map(([config]) => config.api),
      ).toEqual(["pi-claude-cli", "claude-1", "claude-2"]);
      expect(pi.registerProvider.mock.calls[0][1].models[0].id).toBe(
        "claude-test",
      );
      await handlers.get("session_start")({}, ctx);
      for (const [name, config] of pi.registerProvider.mock.calls) {
        expect(config.api).toBe(name);
        expect(config.models).toEqual(
          pi.registerProvider.mock.calls[0][1].models,
        );
        config.streamSimple({ provider: name }, { messages: [], tools: [] });
        const options = vi.mocked(streamViaCli).mock.calls.at(-1)![2]!;
        expect(options.account).toEqual({
          alias: name === "claude-2" ? "claude-2" : "claude-1",
        });
        options.onRateLimit?.({ status: "rejected" });
        expect(
          JSON.parse(ctx.ui.setStatus.mock.calls.at(-1)![1]!),
        ).toMatchObject({
          account: options.account!.alias,
          status: "rejected",
        });
      }
      const command = pi.registerCommand.mock.calls[0][1].handler;
      await command("status", ctx);
      const status = ctx.ui.notify.mock.calls.at(-1)![0];
      expect(status).toContain("claude-1: native default login");
      expect(status).toContain("claude-2:");
      expect(status).toContain("token present: yes");
      expect(status).toContain("pi-claude-cli: alias of claude-1");
      expect(status).not.toContain("status-secret");
      const count = vi.mocked(retireAllCliProcesses).mock.calls.length;
      await command("select claude-2", ctx);
      expect(ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Read-only"),
        "warning",
      );
      expect(retireAllCliProcesses).toHaveBeenCalledTimes(count);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
