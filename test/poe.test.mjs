// Integration test: loads the real extension, runs the async factory (which
// fetches Poe's live /v1/models catalog), and asserts the model mapping and
// the before_provider_request hook behave correctly.
//
// Run:  node test/poe.test.mjs   (from the repo root, with the junctions
// in ./node_modules/@earendil-works created by the setup step — see README)

let pass = 0;
let fail = 0;
function assert(cond, msg) {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", msg);
	}
}
function assertEq(actual, expected, msg) {
	const ok = actual === expected;
	if (ok) pass++;
	else {
		fail++;
		console.error(`  FAIL: ${msg}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
	}
}

const mod = await import("../index.ts");
const factory = mod.default;
assert(typeof factory === "function", "default export is a function");

const registered = [];
const handlers = {};
const pi = {
	registerProvider(provider) {
		registered.push(provider);
	},
	on(event, handler) {
		(handlers[event] ??= []).push(handler);
	},
};

await factory(pi);

assertEq(registered.length, 1, "exactly one provider registered");
const provider = registered[0];
assertEq(provider.id, "poe", "provider id is 'poe'");
assertEq(provider.name, "Poe", "provider name is 'Poe'");
assertEq(provider.baseUrl, "https://api.poe.com/v1", "provider baseUrl");
assert(!!provider.auth?.apiKey, "provider has apiKey auth (for /login)");
assert(typeof provider.auth.apiKey.login === "function", "auth has login() for /login");
assert(typeof provider.auth.apiKey.resolve === "function", "auth has resolve()");
assert(typeof provider.streamSimple === "function", "provider exposes streamSimple (openai-completions)");

const models = provider.getModels();
assert(models.length > 0, `discovered models (count=${models.length})`);

// Every mapped model must have the required fields and our compat overrides.
for (const m of models) {
	assertEq(m.provider, "poe", `model ${m.id}: provider`);
	assertEq(m.api, "openai-completions", `model ${m.id}: api`);
	assertEq(m.baseUrl, "https://api.poe.com/v1", `model ${m.id}: baseUrl`);
	assert(m.contextWindow > 0, `model ${m.id}: contextWindow > 0`);
	assert(m.maxTokens > 0, `model ${m.id}: maxTokens > 0`);
	assert(m.maxTokens <= m.contextWindow, `model ${m.id}: maxTokens <= contextWindow`);
	assert(typeof m.cost.input === "number", `model ${m.id}: cost.input is number`);
	assert(typeof m.cost.output === "number", `model ${m.id}: cost.output is number`);
	assert(Array.isArray(m.input) && m.input.includes("text"), `model ${m.id}: input includes text`);
	assertEq(m.compat?.supportsDeveloperRole, false, `model ${m.id}: supportsDeveloperRole=false (system role)`);
	assertEq(m.compat?.supportsStore, false, `model ${m.id}: supportsStore=false`);
	assertEq(m.compat?.maxTokensField, "max_completion_tokens", `model ${m.id}: maxTokensField`);
	// Unsupported levels must be hidden (null), never sent raw.
	for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		const v = m.thinkingLevelMap?.[lvl];
		if (v !== null && v !== undefined) assert(typeof v === "string", `model ${m.id}: ${lvl} maps to string`);
	}
}

// Media-generation and documented-unavailable bots must be excluded.
assert(!models.some((m) => m.id === "script-bot-creator"), "script-bot-creator excluded");
assert(!models.some((m) => m.id === "app-creator"), "app-creator excluded");
assert(!models.some((m) => /^veo-3/.test(m.id)), "video bots excluded (no veo-3.*)");
assert(!models.some((m) => m.id === "gpt-image-1.5"), "image bots excluded (no gpt-image-1.5)");

// Models with an empty supported_endpoints list are chat-capable and included.
assert(models.some((m) => m.id === "kimi-k3"), "kimi-k3 included (empty endpoint list)");

// Vision models advertise image input.
const vision = models.filter((m) => m.input.includes("image"));
assert(vision.length > 0, "at least one vision model");
const sonnet = models.find((m) => m.id === "claude-sonnet-4.6");
if (sonnet) assert(sonnet.input.includes("image"), "claude-sonnet-4.6 has image input");

// ---- known-model spot checks (live catalog) ----

// Enum-mapped effort model without "none": off falls back to the lowest effort.
const kimi = models.find((m) => m.id === "kimi-k3");
if (kimi) {
	assertEq(kimi.contextWindow, 1000000, "kimi-k3 contextWindow = 1000000");
	assertEq(kimi.reasoning, true, "kimi-k3 reasoning = true");
	assertEq(kimi.compat.supportsReasoningEffort, true, "kimi-k3 supportsReasoningEffort");
	assertEq(kimi.thinkingLevelMap.low, "low", "kimi-k3 low -> low");
	assertEq(kimi.thinkingLevelMap.high, "high", "kimi-k3 high -> high");
	assertEq(kimi.thinkingLevelMap.minimal, null, "kimi-k3 minimal -> hidden");
	assertEq(kimi.thinkingLevelMap.off, "low", "kimi-k3 off -> low (no none offered)");
	assert(kimi.cost.input > 0, "kimi-k3 cost.input > 0 (per-million conversion)");
}

// Enum-mapped effort model with "none" and xhigh.
const gpt54 = models.find((m) => m.id === "gpt-5.4");
if (gpt54) {
	assertEq(gpt54.thinkingLevelMap.off, "none", "gpt-5.4 off -> none");
	assertEq(gpt54.thinkingLevelMap.xhigh, "xhigh", "gpt-5.4 xhigh -> xhigh");
	assertEq(gpt54.thinkingLevelMap.max, null, "gpt-5.4 max -> hidden");
	assertEq(gpt54.contextWindow, 1050000, "gpt-5.4 contextWindow = 1050000");
	assertEq(gpt54.maxTokens, 128000, "gpt-5.4 maxTokens = 128000");
}

// Gemini: thinking_level rename control.
const gemini = models.find((m) => m.id === "gemini-3.1-pro");
if (gemini) {
	assertEq(gemini.reasoning, true, "gemini-3.1-pro reasoning");
	assertEq(gemini.compat.supportsReasoningEffort, true, "gemini-3.1-pro sends effort (renamed by hook)");
	assertEq(gemini.thinkingLevelMap.off, "low", "gemini-3.1-pro off -> low (cannot disable)");
	assertEq(gemini.thinkingLevelMap.medium, null, "gemini-3.1-pro medium hidden");
}

// Claude 4.5+: output_effort rename control with "none".
const opus = models.find((m) => m.id === "claude-opus-4.7");
if (opus) {
	assertEq(opus.thinkingLevelMap.off, "none", "claude-opus-4.7 off -> none");
	assertEq(opus.thinkingLevelMap.max, "max", "claude-opus-4.7 max -> max");
	assertEq(opus.contextWindow, 1048576, "claude-opus-4.7 contextWindow = 1048576");
	assert(opus.cost.cacheRead > 0, "claude-opus-4.7 cacheRead > 0");
	assert(opus.cost.cacheWrite > 0, "claude-opus-4.7 cacheWrite > 0");
}

// Claude budget model: thinking_budget numeric control.
const sonnet45 = models.find((m) => m.id === "claude-sonnet-4.5");
if (sonnet45) {
	assertEq(sonnet45.reasoning, true, "claude-sonnet-4.5 reasoning");
	assertEq(sonnet45.compat.supportsReasoningEffort, false, "claude-sonnet-4.5 no reasoning_effort");
	assert(!!sonnet45.thinkingLevelMap, "claude-sonnet-4.5 has thinkingLevelMap (all levels selectable)");
	assertEq(sonnet45.thinkingLevelMap.max, "max", "claude-sonnet-4.5 max selectable");
}

// enable_thinking model: qwen format.
const qwen = models.find((m) => m.id === "qwen3.5-plus-el");
if (qwen) {
	assertEq(qwen.compat.thinkingFormat, "qwen", "qwen3.5-plus-el thinkingFormat=qwen");
	assertEq(qwen.reasoning, true, "qwen3.5-plus-el reasoning");
}

// enable_thinking + thinking_budget model: qwen format AND budget injection.
const ds = models.find((m) => m.id === "deepseek-v3.2-el");
if (ds) {
	assertEq(ds.compat.thinkingFormat, "qwen", "deepseek-v3.2-el thinkingFormat=qwen");
	assert(!!ds.thinkingLevelMap, "deepseek-v3.2-el has thinkingLevelMap (budget levels selectable)");
}

// ---- before_provider_request hook ----
const hookHandlers = handlers.before_provider_request ?? [];
assertEq(hookHandlers.length, 1, "one before_provider_request handler registered");
const hook = hookHandlers[0];
function runHook(model, thinkingLevel, payload) {
	return hook({ type: "before_provider_request", payload }, { model, thinkingLevel });
}

// Non-poe provider: untouched.
assertEq(runHook({ provider: "openai", id: "gpt-4" }, "medium", { model: "x", messages: [] }), undefined, "non-poe provider untouched");
// Poe model without a hook-managed control: untouched.
if (kimi) {
	assertEq(runHook({ provider: "poe", id: "kimi-k3" }, "high", { model: "kimi-k3" }), undefined, "reasoning_effort model untouched by hook");
}

// Rename control: reasoning_effort -> thinking_level / output_effort.
if (gemini) {
	const out = runHook({ provider: "poe", id: "gemini-3.1-pro" }, "high", { model: "gemini-3.1-pro", messages: [], reasoning_effort: "high" });
	assert(!!out, "gemini hook returns payload");
	assertEq(out.thinking_level, "high", "gemini: reasoning_effort renamed to thinking_level");
	assertEq(out.reasoning_effort, undefined, "gemini: reasoning_effort removed");
	assertEq(out.model, "gemini-3.1-pro", "gemini: other payload fields preserved");
}
if (opus) {
	const out = runHook({ provider: "poe", id: "claude-opus-4.7" }, "off", { model: "claude-opus-4.7", messages: [], reasoning_effort: "none" });
	assertEq(out.output_effort, "none", "opus @ off: output_effort=none");
	assertEq(out.reasoning_effort, undefined, "opus: reasoning_effort removed");
	// No effort in payload (e.g. map gap): hook leaves it alone.
	assertEq(runHook({ provider: "poe", id: "claude-opus-4.7" }, "high", { model: "x" }), undefined, "opus: no reasoning_effort -> untouched");
}

// Budget control: level -> clamped thinking_budget.
if (sonnet45) {
	// claude-sonnet-4.5 declares thinking_budget [0, 31999].
	const off = runHook({ provider: "poe", id: "claude-sonnet-4.5" }, "off", { model: "claude-sonnet-4.5", messages: [] });
	assertEq(off.thinking_budget, 0, "budget model @ off: thinking_budget=0");
	const med = runHook({ provider: "poe", id: "claude-sonnet-4.5" }, "medium", { model: "claude-sonnet-4.5", messages: [] });
	assertEq(med.thinking_budget, 8192, "budget model @ medium: 8192");
	const max = runHook({ provider: "poe", id: "claude-sonnet-4.5" }, "max", { model: "claude-sonnet-4.5", messages: [] });
	assertEq(max.thinking_budget, 31999, "budget model @ max: clamped to declared maximum");
	const none = runHook({ provider: "poe", id: "claude-sonnet-4.5" }, undefined, { model: "claude-sonnet-4.5", messages: [] });
	assertEq(none, undefined, "budget model: undefined level -> untouched");
}

// enable_thinking + budget: budget injected for non-off levels, off untouched
// (pi's qwen format already sends enable_thinking=false).
if (ds) {
	// deepseek-v3.2-el declares thinking_budget [1, 393216].
	const high = runHook({ provider: "poe", id: "deepseek-v3.2-el" }, "high", { model: "deepseek-v3.2-el", messages: [] });
	assertEq(high.thinking_budget, 16384, "enable_thinking+budget @ high: 16384");
	const minimal = runHook({ provider: "poe", id: "deepseek-v3.2-el" }, "minimal", { model: "deepseek-v3.2-el", messages: [] });
	assertEq(minimal.thinking_budget, 1024, "enable_thinking+budget @ minimal: 1024 (clamped >= min 1)");
	const off = runHook({ provider: "poe", id: "deepseek-v3.2-el" }, "off", { model: "deepseek-v3.2-el", messages: [] });
	assertEq(off, undefined, "enable_thinking+budget @ off: untouched (qwen sends enable_thinking=false)");
}

// ---- auth: /login flow + env fallback + stored credential ----
const auth = provider.auth.apiKey;
const mockInteraction = {
	signal: { throwIfAborted() {} },
	prompt: async () => "test-key-from-login",
};
const loginResult = await auth.login(mockInteraction);
assertEq(loginResult.type, "api_key", "login() returns an api_key credential");
assertEq(loginResult.key, "test-key-from-login", "login() returns the prompted key");

const resolveCtx = {
	env: async (name) => (name === "POE_API_KEY" ? process.env.POE_API_KEY : undefined),
};
// Stored credential wins.
const stored = await auth.resolve({ ctx: resolveCtx, credential: { type: "api_key", key: "stored-key" }, signal: { throwIfAborted() {} } });
assertEq(stored.auth.apiKey, "stored-key", "resolve(): stored credential wins");
assertEq(stored.source, "stored credential", "resolve(): source is 'stored credential'");
// Env fallback when no stored credential.
if (process.env.POE_API_KEY) {
	const envd = await auth.resolve({ ctx: resolveCtx, credential: undefined, signal: { throwIfAborted() {} } });
	assertEq(envd.auth.apiKey, process.env.POE_API_KEY, "resolve(): falls back to POE_API_KEY env");
	assertEq(envd.source, "POE_API_KEY", "resolve(): source is the env var name");
}
// Nothing configured -> undefined.
const noneCtx = { env: async () => undefined };
const none = await auth.resolve({ ctx: noneCtx, credential: undefined, signal: { throwIfAborted() {} } });
assertEq(none, undefined, "resolve(): undefined when nothing configured");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
