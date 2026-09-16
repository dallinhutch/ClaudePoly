import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { ZERO, type Dec } from "@/lib/decimal";
import { estimateCostUsd } from "./pricing";
import { toolInputSchema } from "./schemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Server-side refusal fallbacks are only requested for models documented to support them. */
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

let client: Anthropic | undefined;
export function getAnthropic(): Anthropic {
  // Server-side only. The key never reaches the browser.
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearchRequests: number;
}

/** What a call consumed — reported on success AND failure so every dollar is counted. */
export interface AgentSpend {
  /** Model(s) that actually served the calls (fallbacks can substitute). */
  models: string[];
  usage: AgentUsage;
  costUsd: Dec;
  /** URLs that search/fetch tools actually returned — used to flag unverified citations. */
  retrievedUrls: string[];
  turns: number;
}

export interface AgentResult<T> extends AgentSpend {
  output: T;
}

export class AgentCallError extends Error {
  constructor(message: string, readonly spend: AgentSpend, readonly kind: "refusal" | "no_submit" | "api_error", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentCallError";
  }
}

/**
 * Run a research agent: Claude may use server-side web search/fetch, then must
 * call a strict "submit" tool whose input is validated with zod. Handles
 * pause_turn continuation, invalid submissions (sent back as tool errors) and
 * refusal fallbacks. Any failure throws AgentCallError carrying the spend so far.
 */
export async function runSubmitAgent<T>(opts: {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  submitTool: { name: string; description: string; schema: z.ZodType<T> };
  maxWebSearches: number;
  blockedDomains: string[];
  validate?: (value: T) => string[];
  maxTurns?: number;
}): Promise<AgentResult<T>> {
  const anthropic = getAnthropic();
  const maxTurns = opts.maxTurns ?? 10;
  const blocked = opts.blockedDomains.slice(0, 64);

  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (opts.maxWebSearches > 0) {
    tools.push({ type: "web_search_20260209", name: "web_search", max_uses: opts.maxWebSearches, ...(blocked.length ? { blocked_domains: blocked } : {}) });
    tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: opts.maxWebSearches, ...(blocked.length ? { blocked_domains: blocked } : {}) });
  }
  tools.push({
    name: opts.submitTool.name,
    description: opts.submitTool.description,
    input_schema: toolInputSchema(opts.submitTool.schema) as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  });

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.prompt }];
  const usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, webSearchRequests: 0 };
  const models = new Set<string>();
  const retrieved = new Set<string>();
  let costUsd = ZERO;
  let turn = 0;
  // The 2026 web search/fetch tools run code execution internally; once a turn
  // creates a container, every later request in the same exchange must name it.
  let containerId: string | undefined;
  const spend = (): AgentSpend => ({ models: [...models], usage: { ...usage }, costUsd, retrievedUrls: [...retrieved], turns: turn });

  try {
    for (turn = 1; turn <= maxTurns; turn++) {
      const stream = anthropic.beta.messages.stream({
        model: opts.model,
        max_tokens: 32_000,
        ...(containerId ? { container: containerId } : {}),
        ...(SERVER_FALLBACK_MODELS.has(opts.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort },
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });
      const msg = await stream.finalMessage();

      containerId = msg.container?.id ?? containerId;
      models.add(msg.model);
      usage.inputTokens += msg.usage.input_tokens;
      usage.outputTokens += msg.usage.output_tokens;
      usage.cacheCreationTokens += msg.usage.cache_creation_input_tokens ?? 0;
      usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
      usage.webSearchRequests += msg.usage.server_tool_use?.web_search_requests ?? 0;
      costUsd = costUsd.plus(estimateCostUsd(msg.model, msg.usage));

      for (const block of msg.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") retrieved.add(r.url);
        } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
          retrieved.add(block.content.url);
        }
      }

      if (msg.stop_reason === "refusal") {
        throw new AgentCallError(`model declined: ${msg.stop_details?.category ?? "unspecified"}`, spend(), "refusal");
      }

      messages.push({ role: "assistant", content: msg.content });

      const submit = msg.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === opts.submitTool.name,
      );
      if (submit) {
        const parsed = opts.submitTool.schema.safeParse(submit.input);
        const problems = parsed.success ? (opts.validate?.(parsed.data) ?? []) : [parsed.error.message];
        if (parsed.success && problems.length === 0) return { output: parsed.data, ...spend() };
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: submit.id, is_error: true, content: `Submission rejected: ${problems.join("; ")}. Fix and call ${opts.submitTool.name} again.` }],
        });
        continue;
      }

      // Server tool loop paused mid-turn: resend so it can continue.
      if (msg.stop_reason === "pause_turn") continue;

      messages.push({ role: "user", content: `Please call ${opts.submitTool.name} now with your final answer.` });
    }
  } catch (err) {
    if (err instanceof AgentCallError) throw err;
    throw new AgentCallError(`API error: ${err instanceof Error ? err.message : String(err)}`, spend(), "api_error", { cause: err });
  }
  throw new AgentCallError(`agent did not submit a valid ${opts.submitTool.name} within ${maxTurns} turns`, spend(), "no_submit");
}
