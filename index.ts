/**
 * Poe provider extension for pi.
 *
 * Registers the "poe" provider against Poe's OpenAI-compatible Chat
 * Completions API (https://api.poe.com/v1). The full model catalog —
 * including per-model context windows, max output tokens, pricing, input
 * modalities, and reasoning capabilities — is discovered at startup from
 * Poe's public /v1/models endpoint, so context windows and capabilities are
 * always correct for each model.
 *
 * Auth: `/login poe` prompts for a Poe API key (https://poe.com/api/keys) and
 * stores it, with $POE_API_KEY used as an automatic fallback. Chat requests
 * are sent exactly as Poe expects:
 *
 *   - `Authorization: Bearer <key>` (resolved by openai-completions + envApiKeyAuth)
 *   - `system` role (compat.supportsDeveloperRole = false): Poe proxies to
 *     heterogeneous backends, and `system` is the one role they all accept
 *   - `max_completion_tokens` (both fields are supported; the modern one is used)
 *   - `stream_options.include_usage` (Poe supports usage in streaming)
 *
 * Thinking control is per model, derived from the bot's declared `parameters`:
 *
 *   - `reasoning_effort` enum (GPT-5.x, Kimi, Grok, Seed, ...) is sent as the
 *     OpenAI-compatible top-level `reasoning_effort` field — the documented
 *     extra_body mechanism, which is the same JSON key when the payload is
 *     built directly. Pi levels map to exact enum matches; "off" maps to
 *     "none" when offered, otherwise to the lowest offered effort.
 *   - `thinking_level` (Gemini 3.x) and `output_effort` (Claude 4.5+) enums
 *     use the same mapping, then a before_provider_request hook renames the
 *     outgoing `reasoning_effort` key to the parameter the bot actually
 *     declares.
 *   - `thinking_budget` numeric knobs (Claude 4.5 budget models, Gemini 2.5,
 *     DeepSeek, ...) get a token budget from a per-level ladder, clamped to
 *     the bot's declared [min, max]; "off" sends 0 when the bot allows it.
 *   - `enable_thinking` boolean (Qwen, Seed, MiMo, ...) uses pi's built-in
 *     "qwen" thinking format (`enable_thinking: true/false`); models that
 *     also declare `reasoning_effort` get both, and models that also declare
 *     `thinking_budget` get a clamped budget injected for non-off levels.
 *   - Models Poe marks `supports_reasoning_effort` without declaring a
 *     parameter get OpenAI-style pass-through effort.
 *
 * Scope: text-output chat models only (bots that list /v1/chat/completions,
 * or list no endpoints — Poe's default chat interface). Image/video/audio
 * generation bots and the App-Creator / Script-Bot-Creator bots (documented
 * as unavailable via this API) are excluded.
 *
 * Usage:
 *   /login poe          # enter your Poe API key (or export POE_API_KEY)
 *   /model poe/<id>     # pick a model, e.g. poe/Claude-Sonnet-4.6
 *
 * Models are refreshed by /reload (re-runs this factory, re-fetches /v1/models).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const PROVIDER_ID = "poe";
const POE_BASE_URL = "https://api.poe.com/v1";
const POE_MODELS_URL = "https://api.poe.com/v1/models";

// pi thinking levels in increasing order of effort.
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Effort rank shared by Poe's enum-valued thinking knobs.
const EFFORT_RANK: Record<string, number> = {
	none: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};
// Token-budget ladder for numeric `thinking_budget` knobs (before clamping).
const BUDGET_LADDER: Record<string, number> = {
	minimal: 1_024,
	low: 4_096,
	medium: 8_192,
	high: 16_384,
	xhigh: 32_768,
};
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 15_000;
// Documented as unavailable through the OpenAI-compatible API.
const UNAVAILABLE_BOTS = new Set(["app-creator", "script-bot-creator"]);

/**
 * Context windows for chat LLMs where Poe's /v1/models reports no
 * context_window AND the bot description doesn't state one. Sourced from the
 * model vendors' own entries on models.dev (Z.ai, Moonshot, DeepSeek,
 * MiniMax, Alibaba, Amazon, Xiaomi, Meta, Mistral, Tencent, OpenAI). Keys are
 * exact Poe bot ids. Description-stated values (bot-author specific) win over
 * this table; both win over DEFAULT_CONTEXT_WINDOW.
 */
const CONTEXT_OVERRIDES: Record<string, number> = {
	"glm-4.6": 204_800,
	"glm-4.7": 204_800,
	"glm-5": 204_800,
	"glm-5.1": 200_000,
	"glm-5.2": 1_000_000,
	"kimi-k2-thinking": 262_144,
	"kimi-k2.5": 262_144,
	"kimi-k2.6": 262_144,
	"kimi-k2.7-code": 262_144,
	"deepseek-v3.1": 128_000,
	"deepseek-v3.1-terminus": 128_000,
	"deepseek-v3.2": 128_000,
	"deepseek-v4-pro": 1_000_000,
	"deepseek-v4-flash": 1_000_000,
	"minimax-m2": 196_608,
	"minimax-m2.1": 204_800,
	"minimax-m2.5": 204_800,
	"minimax-m2.7": 204_800,
	"minimax-m2.7-fw": 204_800,
	"minimax-m3": 1_000_000,
	"qwen3-max-el": 262_144,
	"qwen3-max-preview-el": 262_144,
	"qwen3.5-flash-el": 1_000_000,
	"qwen3.7-plus": 1_000_000,
	"qwen3.7-flash-el": 1_000_000,
	"qwen3.7-max-el": 1_000_000,
	"qwen3.8-max-el": 1_000_000,
	"gpt-oss-120b": 131_072,
	"gpt-oss-20b-t": 131_072,
	"mimo-v2.5-pro": 1_048_576,
	"gemma-3-27b": 128_000,
	hy3: 256_000,
	"muse-spark-1-1": 1_000_000,
	"mistral-medium-3.1": 262_144,
	"nova-pro-1.0": 300_000,
	"nova-lite-1.0": 300_000,
	"nova-micro-1.0": 128_000,
	"nova-premier-1.0": 1_000_000,
	"nova-lite-2": 1_000_000,
};

// Ordered context-window patterns for bot descriptions; first match wins.
// Connectors deliberately exclude newlines so "tokens >128k\n- Context
// Window: 256k" can't false-match the pricing line.
const CONTEXT_PATTERNS = [
	/context[ \t]*window[ \t]*[:=]?[ \t]*(?:up to[ \t]+)?(\d+(?:\.\d+)?)[ \t]*([km])\b/i,
	/(\d+(?:\.\d+)?)[ \t]*([km])[ \t]*(?:tokens?[ \t]*)?[-–]?[ \t]*context(?:[ \t]window)?/i,
	/context[ \t]*(?:window)?[ \t]*(?:of|is)?[ \t]*(?:up to[ \t]+)?(\d+(?:\.\d+)?)[ \t]*([km])\b/i,
];

/** Parse a context window ("1M", "256k") from a bot description, if stated. */
function parseContextFromDescription(description: string | undefined): number | undefined {
	if (!description) return undefined;
	for (const pattern of CONTEXT_PATTERNS) {
		const match = description.match(pattern);
		if (match) {
			const value = Math.round(
				Number.parseFloat(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000),
			);
			if (value >= 1_000 && value <= 10_000_000) return value;
		}
	}
	return undefined;
}

/**
 * Build a pi thinkingLevelMap from a Poe bot's enum-valued effort options.
 *
 * Exact matches map to themselves; levels with no exact match are hidden
 * (null). "off" maps to "none" when the bot offers it, otherwise to the
 * lowest-effort value the bot accepts (closest achievable behavior — e.g.
 * Gemini 3 can't disable thinking, so "off" sends its lowest level).
 */
function buildEnumLevelMap(options: string[]): ThinkingLevelMap {
	const supported = new Set(options);
	const map: ThinkingLevelMap = {};
	if (supported.has("none")) {
		map.off = "none";
	} else {
		const lowest = options
			.filter((o) => EFFORT_RANK[o] !== undefined)
			.sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])[0];
		if (lowest) map.off = lowest;
	}
	for (const level of PI_LEVELS) {
		if (level === "off") continue;
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

/** Map a pi thinking level to a thinking_budget value, clamped to [min, max]. */
function budgetForLevel(level: string, min: number, max: number): number {
	let budget: number;
	if (level === "off") {
		budget = min === 0 ? 0 : min; // disable when the bot allows 0, else minimal thinking
	} else if (level === "max") {
		budget = max;
	} else {
		budget = BUDGET_LADDER[level] ?? BUDGET_LADDER.medium;
	}
	return Math.max(min, Math.min(max, Math.floor(budget)));
}

// ---- Poe /v1/models response shape (only the fields we use) ----

interface PoePricing {
	prompt?: string | null;
	completion?: string | null;
	input_cache_read?: string | null;
	input_cache_write?: string | null;
}

interface PoeParameter {
	name: string;
	schema?: {
		enum?: string[];
		type?: string;
		minimum?: number;
		maximum?: number;
	};
	default_value?: unknown;
}

interface PoeReasoning {
	budget?: { max_tokens?: number; min_tokens?: number } | null;
	required?: boolean;
	supports_reasoning_effort?: boolean;
}

interface PoeModel {
	id: string;
	description?: string;
	owned_by?: string;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	} | null;
	supported_features?: string[] | null;
	supported_endpoints?: string[] | null;
	pricing?: PoePricing | null;
	context_window?: {
		context_length?: number | null;
		max_output_tokens?: number | null;
	} | null;
	context_length?: number | null;
	reasoning?: PoeReasoning | null;
	parameters?: PoeParameter[] | null;
	metadata?: { display_name?: string } | null;
}

/** How pi drives a model's thinking, derived from the bot's declared parameters. */
type ThinkingControl =
	| { kind: "reasoning_effort" } // pi's generic path sends top-level reasoning_effort
	| { kind: "rename"; param: "thinking_level" | "output_effort" } // hook renames reasoning_effort
	| { kind: "budget"; min: number; max: number } // hook injects thinking_budget
	// compat "qwen" (+ reasoning_effort, + thinking_budget via hook)
	| { kind: "enable_thinking"; withEffort: boolean; budget?: { min: number; max: number } }
	| { kind: "effort_passthrough" } // Poe says effort is supported, no enum declared
	| { kind: "none" };

interface DiscoveredCatalog {
	models: Model<Api>[];
	controls: Map<string, ThinkingControl>;
}

/** Per-million USD from Poe's per-token price strings. */
function perMillion(price: string | null | undefined): number {
	const perToken = price ? Number.parseFloat(price) : Number.NaN;
	return Number.isFinite(perToken) ? perToken * 1_000_000 : 0;
}

/** Decide how a bot's thinking is controlled, from its declared parameters. */
function resolveThinkingControl(m: PoeModel): { control: ThinkingControl; effortEnum?: string[] } {
	const params = m.parameters ?? [];
	const find = (name: string) => params.find((p) => p.name === name);

	const effort = find("reasoning_effort")?.schema?.enum;
	const enableThinking = !!find("enable_thinking");
	if (enableThinking) {
		// qwen format sends enable_thinking; reasoning_effort rides along when
		// declared. A declared thinking_budget is honored too: the hook injects a
		// clamped budget for non-off levels (enable_thinking stays the off switch —
		// these budgets typically have min >= 1 and can't disable thinking alone).
		const budgetParam = find("thinking_budget");
		const budgetMax = budgetParam?.schema?.maximum ?? m.reasoning?.budget?.max_tokens;
		const budget =
			budgetParam && budgetMax && budgetMax > 0
				? { min: budgetParam.schema?.minimum ?? m.reasoning?.budget?.min_tokens ?? 0, max: budgetMax }
				: undefined;
		return {
			control: { kind: "enable_thinking", withEffort: !!effort, ...(budget ? { budget } : {}) },
			effortEnum: effort,
		};
	}
	if (effort?.length) return { control: { kind: "reasoning_effort" }, effortEnum: effort };

	const thinkingLevel = find("thinking_level")?.schema?.enum;
	if (thinkingLevel?.length) return { control: { kind: "rename", param: "thinking_level" }, effortEnum: thinkingLevel };

	const outputEffort = find("output_effort")?.schema?.enum;
	if (outputEffort?.length) return { control: { kind: "rename", param: "output_effort" }, effortEnum: outputEffort };

	const budget = find("thinking_budget");
	if (budget) {
		const min = budget.schema?.minimum ?? m.reasoning?.budget?.min_tokens ?? 0;
		const max = budget.schema?.maximum ?? m.reasoning?.budget?.max_tokens;
		if (max && max > 0) return { control: { kind: "budget", min, max } };
	}

	if (m.reasoning?.supports_reasoning_effort) return { control: { kind: "effort_passthrough" } };
	return { control: { kind: "none" } };
}

/** Fetch Poe's public model catalog and map every chat model to a pi Model. */
async function discoverPoeModels(signal?: AbortSignal): Promise<DiscoveredCatalog> {
	const res = await fetch(POE_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Poe /v1/models returned HTTP ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as { data?: PoeModel[] };
	const data = body.data ?? [];

	const models: Model<Api>[] = [];
	const controls = new Map<string, ThinkingControl>();

	for (const m of data) {
		// Only text-output models usable through Chat Completions. An empty/
		// missing supported_endpoints list means Poe's default chat interface.
		const output = m.architecture?.output_modalities ?? ["text"];
		if (!output.includes("text")) continue;
		const endpoints = m.supported_endpoints ?? [];
		if (endpoints.length > 0 && !endpoints.includes("/v1/chat/completions")) continue;
		if (UNAVAILABLE_BOTS.has(m.id.toLowerCase())) continue;

		// Poe's structured field wins; then the bot description (what the bot
		// author actually serves); then the curated table; then the default.
		const contextWindow =
			m.context_window?.context_length ??
			m.context_length ??
			parseContextFromDescription(m.description) ??
			CONTEXT_OVERRIDES[m.id] ??
			DEFAULT_CONTEXT_WINDOW;
		const maxTokens = Math.min(
			contextWindow,
			m.context_window?.max_output_tokens ?? DEFAULT_MAX_TOKENS,
		);
		const input: ("text" | "image")[] = m.architecture?.input_modalities?.includes("image")
			? ["text", "image"]
			: ["text"];

		const { control, effortEnum } = resolveThinkingControl(m);
		const reasoning =
			control.kind !== "none" || !!(m.reasoning?.required || m.reasoning?.budget);

		// thinkingLevelMap drives the thinking selector (exact enum matches,
		// unsupported levels hidden). For budget models every level is meaningful;
		// identity values keep them all selectable without sending effort fields.
		let thinkingLevelMap: ThinkingLevelMap | undefined;
		if (effortEnum) {
			thinkingLevelMap = buildEnumLevelMap(effortEnum);
		} else if (control.kind === "budget" || (control.kind === "enable_thinking" && control.budget)) {
			thinkingLevelMap = Object.fromEntries(PI_LEVELS.map((l) => [l, l]));
		}

		const sendsEffort =
			control.kind === "reasoning_effort" ||
			control.kind === "rename" ||
			control.kind === "effort_passthrough" ||
			(control.kind === "enable_thinking" && control.withEffort);

		const model = {
			id: m.id,
			name: m.metadata?.display_name ?? m.id,
			api: "openai-completions" as const,
			provider: PROVIDER_ID,
			baseUrl: POE_BASE_URL,
			reasoning,
			input,
			cost: {
				input: perMillion(m.pricing?.prompt),
				output: perMillion(m.pricing?.completion),
				cacheRead: perMillion(m.pricing?.input_cache_read),
				cacheWrite: perMillion(m.pricing?.input_cache_write),
			},
			contextWindow,
			maxTokens,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			compat: {
				// Poe proxies to heterogeneous backends; "system" is universally accepted.
				supportsDeveloperRole: false,
				// Poe ignores `store`; keep it out of the payload.
				supportsStore: false,
				// Both fields are supported; use the modern one.
				maxTokensField: "max_completion_tokens" as const,
				supportsReasoningEffort: sendsEffort,
				...(control.kind === "enable_thinking" ? { thinkingFormat: "qwen" as const } : {}),
			},
		} as unknown as Model<Api>;

		models.push(model);
		controls.set(m.id, control);
	}

	models.sort((a, b) => a.name.localeCompare(b.name));
	return { models, controls };
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let catalog: DiscoveredCatalog = { models: [], controls: new Map() };
	try {
		catalog = await discoverPoeModels();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[poe] model discovery failed: ${message}. ` +
				`The provider is still available via \`/login poe\`; run /reload to retry discovery.`,
		);
	}

	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Poe",
			baseUrl: POE_BASE_URL,
			// envApiKeyAuth gives `/login poe` (prompts + stores the key) AND
			// a $POE_API_KEY env-var fallback. The resolved key is sent as
			// `Authorization: Bearer <key>` by the openai-completions API.
			auth: { apiKey: envApiKeyAuth("Poe API key", ["POE_API_KEY"]) },
			api: openAICompletionsApi(),
			models: catalog.models,
		}),
	);

	// Translate pi's generic reasoning_effort payload field into the parameter
	// name each bot actually declares, and inject thinking_budget values.
	// Scoped to the poe provider so unrelated providers are untouched. Runs per
	// request; returning a new payload replaces the outgoing body.
	pi.on("before_provider_request", ((event: { payload: unknown }, ctx: { model?: { provider?: string; id?: string }; thinkingLevel?: string }) => {
		const model = ctx.model;
		if (model?.provider !== PROVIDER_ID) return;
		const payload = event.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return;
		const control = model.id ? catalog.controls.get(model.id) : undefined;
		if (!control) return;

		if (control.kind === "rename") {
			// pi already clamped the level and mapped it through thinkingLevelMap;
			// only the key name is wrong for this bot.
			const effort = payload.reasoning_effort;
			if (typeof effort !== "string") return;
			const next = { ...payload, [control.param]: effort };
			delete next.reasoning_effort;
			return next;
		}

		if (control.kind === "budget") {
			const level = ctx.thinkingLevel;
			if (!level) return; // unknown level: leave the bot's default budget alone
			return { ...payload, thinking_budget: budgetForLevel(level, control.min, control.max) };
		}

		if (control.kind === "enable_thinking" && control.budget) {
			// pi's qwen format already sends enable_thinking (false at "off", which
			// needs no budget); add the level's budget for thinking-enabled levels.
			const level = ctx.thinkingLevel;
			if (!level || level === "off") return;
			return { ...payload, thinking_budget: budgetForLevel(level, control.budget.min, control.budget.max) };
		}
	}) as never);
}
