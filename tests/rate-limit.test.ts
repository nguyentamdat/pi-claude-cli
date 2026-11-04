import { describe, it, expect } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  appendClaudeLimitDiagnostic,
  buildRateLimitPayload,
  rateLimitIdentity,
} from "../src/rate-limit";

// Captured verbatim from claude 2.1.231 on a Team account that had gone past
// its usage-credit allowance. This exact shape is what the UI has to render.
const OVER_CREDITS = {
  status: "allowed_warning",
  resetsAt: 1788220800,
  rateLimitType: "overage",
  utilization: 1.01,
  isUsingOverage: false,
  surpassedThreshold: 1,
};

describe("buildRateLimitPayload", () => {
  it("forwards utilization and surpassedThreshold, which used to be dropped", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload.utilization).toBe(1.01);
    expect(payload.surpassedThreshold).toBe(1);
  });

  it("keeps the fields the UI already relied on", () => {
    const payload = buildRateLimitPayload(OVER_CREDITS, 1_700_000_000);
    expect(payload).toMatchObject({
      status: "allowed_warning",
      resetsAt: 1788220800,
      rateLimitType: "overage",
      observedAt: 1_700_000_000,
    });
  });

  it("normalises isUsingOverage to a real boolean", () => {
    // The CLI sends a boolean, but a truthy non-boolean must not leak through
    // as one — the UI branches on it to warn about paid usage.
    expect(buildRateLimitPayload({ isUsingOverage: true }).isUsingOverage).toBe(
      true,
    );
    expect(
      buildRateLimitPayload({ isUsingOverage: "yes" }).isUsingOverage,
    ).toBe(false);
    expect(buildRateLimitPayload({}).isUsingOverage).toBe(false);
  });

  it("returns null rather than a bogus number for missing metrics", () => {
    // surpassedThreshold is absent until a threshold is actually crossed, and
    // `undefined` must not render as 0% — that reads as "plenty of room left".
    const payload = buildRateLimitPayload({ rateLimitType: "five_hour" });
    expect(payload.utilization).toBeNull();
    expect(payload.surpassedThreshold).toBeNull();
  });

  it("rejects non-finite and non-numeric metrics", () => {
    for (const bad of [NaN, Infinity, "1.01", null, {}]) {
      expect(
        buildRateLimitPayload({ utilization: bad }).utilization,
      ).toBeNull();
    }
  });

  it("carries a utilization of 0 through, which is meaningfully different from unknown", () => {
    expect(buildRateLimitPayload({ utilization: 0 }).utilization).toBe(0);
  });
});

describe("rateLimitIdentity", () => {
  const at = (seconds: number) => buildRateLimitPayload(OVER_CREDITS, seconds);

  it("ignores observedAt, so a repeated event is not a change", () => {
    // The CLI re-sends this every turn with a fresh timestamp. Treating that
    // as a change would rewrite the host's status constantly.
    expect(rateLimitIdentity(at(1000))).toBe(rateLimitIdentity(at(2000)));
  });

  it("changes when utilization moves", () => {
    const before = rateLimitIdentity(at(1000));
    const after = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, utilization: 1.4 }, 1000),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the window itself changes", () => {
    const fiveHour = rateLimitIdentity(
      buildRateLimitPayload({ ...OVER_CREDITS, rateLimitType: "five_hour" }),
    );
    expect(fiveHour).not.toBe(rateLimitIdentity(at(1000)));
  });
});

describe("appendClaudeLimitDiagnostic", () => {
  const message = (
    stopReason: AssistantMessage["stopReason"] = "error",
    text = "Request refused",
  ): AssistantMessage => ({
    role: "assistant",
    provider: "pi-claude-cli",
    api: "pi-claude-cli",
    model: "claude-opus-5",
    stopReason,
    content: [{ type: "text", text }],
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  it("persists a typed rejection diagnostic alongside existing diagnostics", () => {
    const output = message();
    output.diagnostics = [{ type: "existing", timestamp: 0 }];
    appendClaudeLimitDiagnostic(output, {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1787331600,
    });
    expect(JSON.parse(JSON.stringify(output)).diagnostics).toEqual([
      { type: "existing", timestamp: 0 },
      {
        type: "claude-limit",
        timestamp: expect.any(Number),
        details: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1787331600,
        },
      },
    ]);
    expect(output.stopReason).toBe("error");
    expect(output.content).toEqual([{ type: "text", text: "Request refused" }]);
  });

  it.each(["allowed", "allowed_warning", "unknown", undefined])(
    "does not treat %s or rejected overage as request refusal",
    (status) => {
      const output = message();
      appendClaudeLimitDiagnostic(output, {
        status,
        overageStatus: "rejected",
      });
      expect(output.diagnostics).toBeUndefined();
    },
  );

  it("does not infer rejection without an event", () => {
    const output = message(
      "stop",
      "You've hit your 5-hour limit · resets 5:10pm",
    );
    appendClaudeLimitDiagnostic(output, undefined);
    expect(output.diagnostics).toBeUndefined();
  });

  it.each([
    "You've hit your 5-hour limit · resets 5:10pm",
    "You’ve hit your weekly limit · resets tomorrow",
    "Error: You have reached your limit",
  ])("marks a short CLI notice: %s", (notice) => {
    const output = message("stop", notice);
    appendClaudeLimitDiagnostic(output, { status: "rejected" });
    expect(output.diagnostics?.[0].details).toEqual({ status: "rejected" });
    expect(output.stopReason).toBe("stop");
  });

  it.each([
    "Task completed",
    "The user said: You've hit your 5-hour limit · resets 5:10pm",
    '"You\'ve hit your limit" is an example notice.',
    "You've hit your limit · " + "x".repeat(500),
  ])("leaves ordinary/quoted/long stop content unchanged: %s", (text) => {
    const output = message("stop", text);
    appendClaudeLimitDiagnostic(output, { status: "rejected" });
    expect(output.diagnostics).toBeUndefined();
  });

  it.each(["aborted", "toolUse", "length"] as const)(
    "never marks %s",
    (reason) => {
      const output = message(reason, "You've hit your limit");
      appendClaudeLimitDiagnostic(output, { status: "rejected" });
      expect(output.diagnostics).toBeUndefined();
    },
  );

  it("does not mark a notice accompanied by non-text content", () => {
    const output = message("stop", "You've hit your limit");
    output.content.push({ type: "thinking", thinking: "analysis" });
    appendClaudeLimitDiagnostic(output, { status: "rejected" });
    expect(output.diagnostics).toBeUndefined();
  });

  it("can mark legacy failures without changing their stop reason", () => {
    const output = message("stop");
    appendClaudeLimitDiagnostic(
      output,
      { status: "rejected", resetsAt: NaN },
      true,
    );
    expect(output.diagnostics?.[0].details).toEqual({ status: "rejected" });
    expect(output.stopReason).toBe("stop");
  });
});
