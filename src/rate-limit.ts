import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ClaudeRateLimitEvent } from "./types.js";

/**
 * Account rate-limit state, shaped for the host's status channel.
 *
 * The CLI emits a `rate_limit_event` per turn describing ONE window: the first
 * one whose warning threshold has been crossed, walking
 * `5h -> 7d -> 7d_oi -> overage`. So the reported window is the binding
 * constraint, not an arbitrary pick — and there is no way to see all four at
 * once from this stream. A front-end that wants "which limit will stop me, how
 * close am I, and when does it reset" has everything it needs; one that wants
 * a full dashboard does not, and should not pretend otherwise.
 *
 * Kept pure and separate from `index.ts` so the payload contract is testable
 * without a pi runtime.
 */

/** What the host receives under the `claude-rate-limit` status key. */
export interface RateLimitPayload {
  /** Manual profile alias, when the extension supplied one (never credential metadata). */
  account?: string;
  status: unknown;
  resetsAt: unknown;
  rateLimitType: unknown;
  overageStatus: unknown;
  isUsingOverage: boolean;
  /** Fraction of the window consumed: 1.01 means 101%, i.e. over. */
  utilization: number | null;
  /** Which warning step tripped, when one has. */
  surpassedThreshold: number | null;
  observedAt: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildRateLimitPayload(
  info: Record<string, unknown>,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  account?: string,
): RateLimitPayload {
  return {
    ...(account ? { account } : {}),
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    overageStatus: info.overageStatus,
    isUsingOverage: info.isUsingOverage === true,
    // The CLI has always sent these two; dropping them left front-ends able to
    // say WHICH limit was in play and when it resets, but never how close it
    // was — so a user could not watch themselves approach a wall, only hit it.
    utilization: num(info.utilization),
    surpassedThreshold: num(info.surpassedThreshold),
    observedAt: nowSeconds,
  };
}

/**
 * Identity of a payload ignoring `observedAt`, for change detection.
 *
 * The event repeats every turn with a fresh timestamp; pushing that verbatim
 * would rewrite the host's status constantly and make anything rendering it
 * flicker. Comparing everything EXCEPT the timestamp is what makes the push
 * "on change" rather than "on turn".
 */
export function rateLimitIdentity(payload: RateLimitPayload): string {
  const { observedAt: _observedAt, ...rest } = payload;
  return JSON.stringify(rest);
}

// The CLI sometimes returns its quota notice as a successful assistant stop.
const CLI_LIMIT_NOTICE =
  /^(?:Error:\s*)?(?:you(?:'|’)ve|you have) (?:hit|reached) your (?:(?!context|token|output)[\w-]+ )?limit(?:\s*[·—–\-:,.]|\s*$)/i;

/** Fallback extensions recognize errorMessage rate-limit text for every provider id. */
export function normalizeClaudeLimitFailure(
  message: AssistantMessage,
  failureText?: string,
): boolean {
  if (message.stopReason !== "stop" && message.stopReason !== "error")
    return false;
  const rejected = message.diagnostics?.some(
    (item) =>
      item.type === "claude-limit" && item.details?.status === "rejected",
  );
  const textOnly = message.content.every((part) => part.type === "text");
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
  const notice = textOnly && text.length <= 500 && CLI_LIMIT_NOTICE.test(text);
  const failure =
    failureText &&
    /rate[ _-]?limit|too many requests|\b429\b|insufficient_quota|quota.{0,30}(?:exceeded|exhausted|reached)|(?:usage|subscription|weekly|daily) limit/i.test(
      failureText,
    );
  if (!rejected && !notice && !failure) return false;
  message.stopReason = "error";
  message.errorMessage = `Claude rate limit: request rejected.${failureText ? ` ${failureText}` : ""}`;
  return true;
}
/** Persist a rejected request in Pi's native diagnostics, without changing turn semantics. */
export function appendClaudeLimitDiagnostic(
  message: AssistantMessage,
  info: ClaudeRateLimitEvent["rate_limit_info"],
  failed = message.stopReason === "error",
  account?: string,
): void {
  // A rejected nested window/overage alone does not mean the request was refused.
  if (info?.status !== "rejected") return;
  if (!failed) {
    if (
      message.stopReason !== "stop" ||
      message.content.some((part) => part.type !== "text")
    )
      return;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text.length > 500 || !CLI_LIMIT_NOTICE.test(text)) return;
  }
  (message.diagnostics ??= []).push({
    type: "claude-limit",
    timestamp: Date.now(),
    details: {
      ...(account ? { account } : {}),
      status: "rejected",
      ...(typeof info.rateLimitType === "string"
        ? { rateLimitType: info.rateLimitType }
        : {}),
      ...(typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
        ? { resetsAt: info.resetsAt }
        : {}),
    },
  });
}
