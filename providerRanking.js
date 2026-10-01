// Which OpenRouter providers may serve a model, in which order.
//
// A provider qualifies when OpenRouter lists its endpoint as zero data
// retention, its headquarters are outside China (Singapore and Hong Kong
// count, since several Chinese labs route through them), it is not on the
// user's ignore list, and a live probe showed it keeps reasoning out of the
// visible answer. Qualified providers are ordered by effective cost for a
// coding-agent workload, which is almost all cache reads: a provider whose
// prompt cache never hit is priced at its full input rate.
//
// The router sends the result as provider.only + provider.order, so a chat
// stays on one provider (its cache stays warm) and falls back only to other
// qualified ones.
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://openrouter.ai/api/v1';
const STORE = path.join(os.homedir(), '.agent-view', 'router-providers.json');
const EXCLUDED_HQ = new Set(['CN', 'SG', 'HK', 'MO']);
// Not Chinese-headquartered on OpenRouter's list, but founded by or tied to
// Chinese groups; kept out to be safe.
const LINKED = ['novita', 'phala'];
// OpenRouter lists no headquarters for these; looked up 2026-10-01 (company
// sites, Crunchbase). Any other provider without a listed headquarters is
// left out.
const KNOWN_HQ = { relace: 'US', reka: 'US', makora: 'US', digitalocean: 'US' };
// Token mix of a long Claude Code chat (measured on a 280-subagent session):
// 97.6 % cache reads, 1.9 % fresh input, 0.5 % output.
const MIX = { cacheRead: 0.976, input: 0.019, output: 0.005 };
const QUALIFY_MAX_AGE_MS = 7 * 24 * 3600e3;
// A run where a provider only answered 429 or 5xx is redone a day later.
const UNPROBED_MAX_AGE_MS = 24 * 3600e3;
// A provider that rejected a real request comes back after two weeks.
const REJECT_TTL_MS = 14 * 24 * 3600e3;

// Measured 2026-10-01 for deepseek/deepseek-v4-flash-0731, so a first chat is
// routed well before any qualification has run on the user's machine.
const SEED = {
	'deepseek/deepseek-v4-flash-0731': {
		at: '2026-10-01T09:00:00.000Z',
		source: 'seed',
		ranked: ['sail-research/us', 'deepinfra/fp8', 'relace/fp4', 'makora', 'reka', 'digitalocean', 'inceptron/fp4', 'together', 'venice', 'wafer/fast', 'coreweave/fp8'],
		excluded: {
			'open-inference/fp8': 'reasoning leaked into the answer',
			'baseten/fp8': 'reasoning leaked into the answer',
			'morph/bf16': 'reasoning leaked into the answer',
		},
	},
};

function score(price, cacheWorks) {
	const cacheRead = cacheWorks && Number.isFinite(price.cacheRead) ? price.cacheRead : price.input;
	return MIX.cacheRead * cacheRead + MIX.input * price.input + MIX.output * price.output;
}

function readStore() {
	try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { return { models: {} }; }
}

// Every Agent View window reads this file on each routed request, so a write
// goes to a temp file first and replaces the store in one rename.
function writeStore(store) {
	const text = `${JSON.stringify(store, null, 2)}\n`;
	const tmp = `${STORE}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(STORE), { recursive: true });
		fs.writeFileSync(tmp, text);
		try { fs.renameSync(tmp, STORE); } catch (_) {
			// Windows refuses the rename while another process holds the file.
			fs.writeFileSync(STORE, text);
			try { fs.unlinkSync(tmp); } catch (__) { /* left for the next write */ }
		}
	} catch (_) { /* read-only home: ranking stays in memory */ }
}

async function getJson(fetchImpl, url, key) {
	const res = await fetchImpl(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return res.json();
}

// Eligible endpoints of a model from OpenRouter's public lists, cheapest
// first, assuming every cache works. No request is sent to any model.
// The ranking and a qualification run start on the same first request; one
// download of the three lists (one near 1 MB) serves both for ten minutes.
// Each caller gets its own copy, since qualify() writes into "excluded".
const listCache = new Map();
function candidates(model, { fetchImpl = globalThis.fetch, ignore = [], now = Date.now() } = {}) {
	const key = `${model}|${[...ignore].sort().join(',')}`;
	let hit = listCache.get(key);
	if (!hit || hit.fetchImpl !== fetchImpl || now >= hit.until) {
		const promise = fetchCandidates(model, { fetchImpl, ignore });
		hit = { promise, fetchImpl, until: now + 600e3 };
		listCache.set(key, hit);
		promise.catch(() => { if (listCache.get(key) === hit) listCache.delete(key); });
	}
	return hit.promise.then((r) => ({ eligible: r.eligible.map((e) => ({ ...e })), excluded: { ...r.excluded } }));
}

async function fetchCandidates(model, { fetchImpl, ignore }) {
	const [endpoints, zdr, providers] = await Promise.all([
		getJson(fetchImpl, `${API}/models/${model}/endpoints`),
		getJson(fetchImpl, `${API}/endpoints/zdr`),
		getJson(fetchImpl, `${API}/providers`),
	]);
	const hq = new Map((providers.data || []).map((p) => [p.slug, p.headquarters || null]));
	const shortName = model.split('/').pop();
	const zdrNames = new Set((zdr.data || [])
		.filter((e) => String(e.model_id || e.model || '').includes(shortName))
		.map((e) => String(e.provider_name || e.provider || '').toLowerCase()));
	const ignored = new Set([...LINKED, ...ignore].map((s) => String(s).toLowerCase()));
	const eligible = [];
	const excluded = {};
	for (const ep of (endpoints.data && endpoints.data.endpoints) || []) {
		const slug = String(ep.tag || ep.provider_slug || ep.provider_name);
		const base = slug.split('/')[0];
		const p = ep.pricing || {};
		const price = { input: Number(p.prompt) * 1e6, output: Number(p.completion) * 1e6, cacheRead: Number(p.input_cache_read || p.prompt) * 1e6 };
		if (!zdrNames.has(String(ep.provider_name).toLowerCase()) && !zdrNames.has(base)) { excluded[slug] = 'not zero data retention'; continue; }
		const where = hq.get(base) || KNOWN_HQ[base] || null;
		if (!where) { excluded[slug] = 'headquarters unknown'; continue; }
		if (EXCLUDED_HQ.has(where)) { excluded[slug] = `headquarters ${where}`; continue; }
		if (ignored.has(base) || ignored.has(slug)) { excluded[slug] = 'ignored'; continue; }
		eligible.push({ slug, provider: ep.provider_name, price, context: ep.context_length, quantization: ep.quantization || null, score: score(price, true) });
	}
	eligible.sort((a, b) => a.score - b.score);
	return { eligible, excluded };
}

const FILLER = `You are a careful assistant. Reference manual follows.\n${Array.from({ length: 300 }, (_, i) => `Rule ${i + 1}: keep answers short, cite the rule number when asked, never invent facts, and prefer plain words over jargon in every reply.`).join('\n')}`;

// A probe that runs into the timeout counts as a 504, which is retried like
// any other server error.
async function post(fetchImpl, url, init) {
	try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(90000) }); } catch (_) {
		return { ok: false, status: 504, json: async () => ({}) };
	}
}

async function probe(fetchImpl, key, model, slug, question) {
	const res = await post(fetchImpl, `${API}/messages`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({
			model,
			max_tokens: 400,
			system: [{ type: 'text', text: FILLER, cache_control: { type: 'ephemeral' } }],
			messages: [{ role: 'user', content: question }],
			thinking: { type: 'adaptive' },
			provider: { only: [slug], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
			session_id: `agent-view-qualify-${slug}`,
		}),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) return { ok: false, status: res.status };
	const content = Array.isArray(body.content) ? body.content : [];
	const firstText = content.findIndex((b) => b.type === 'text');
	const firstThinking = content.findIndex((b) => b.type === 'thinking');
	const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
	return {
		ok: true,
		// Text ahead of the thinking block, or an answer padded with reasoning,
		// is the leak that showed up as a wall of thoughts in the chat.
		textFirst: firstText >= 0 && firstThinking > firstText,
		text,
		cacheRead: (body.usage && body.usage.cache_read_input_tokens) || 0,
		cost: (body.usage && body.usage.cost) || 0,
	};
}

// A tool definition in the style Claude Code sends (draft-07 $schema,
// additionalProperties false, enums), and a question that needs it.
const PROBE_TOOL = {
	name: 'get_weather',
	description: 'Current weather for a city.',
	input_schema: {
		$schema: 'http://json-schema.org/draft-07/schema#',
		type: 'object',
		properties: { city: { type: 'string', description: 'City name' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } },
		required: ['city'],
		additionalProperties: false,
	},
};

async function probeTool(fetchImpl, key, model, slug) {
	const res = await post(fetchImpl, `${API}/messages`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({
			model,
			max_tokens: 400,
			tools: [PROBE_TOOL],
			messages: [{ role: 'user', content: 'What is the weather in Berlin? Use the get_weather tool.' }],
			provider: { only: [slug], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
		}),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) return { ok: false, status: res.status };
	const call = (body.content || []).find((b) => b.type === 'tool_use');
	return { ok: !!(call && call.name === 'get_weather' && call.input && /berlin/i.test(String(call.input.city))), cost: (body.usage && body.usage.cost) || 0 };
}

// Providers this machine saw reject a real Claude Code request (see demote).
// They stay out of every ranking for that model for REJECT_TTL_MS.
const REJECTED = /^rejected a Claude Code request/;
function rejectionsFor(model, now = Date.now()) {
	const entry = (readStore().models || {})[model];
	if (!entry) return {};
	const at = entry.rejectedAt || {};
	return Object.fromEntries(Object.entries(entry.excluded || {}).filter(([slug, reason]) =>
		REJECTED.test(String(reason)) && now - Date.parse(at[slug] || entry.at) < REJECT_TTL_MS));
}

const transient = (r) => !r.ok && (r.status === 429 || r.status >= 500);

// One retry after a rate limit or server error. A provider that still fails
// that way is left unprobed: out of this ranking, but not excluded.
async function withRetry(fn, delayMs) {
	const first = await fn();
	if (!transient(first)) return first;
	await new Promise((r) => setTimeout(r, delayMs));
	return fn();
}

// Live check of the cheapest candidates: two plain calls with the same
// ~9k-token prefix (reasoning kept out of the answer, cache hit) and one tool
// call. Costs well under a cent per provider.
async function qualify(model, key, { fetchImpl = globalThis.fetch, ignore = [], top = 8, log = () => {}, retryDelayMs = 5000 } = {}) {
	const { eligible, excluded } = await candidates(model, { fetchImpl, ignore });
	const rejected = rejectionsFor(model);
	Object.assign(excluded, rejected);
	const tested = [];
	const unprobed = {};
	let spent = 0;
	for (const c of eligible.filter((e) => !rejected[e.slug]).slice(0, top)) {
		const a = await withRetry(() => probe(fetchImpl, key, model, c.slug, 'What is 17 times 23? Answer with the number only.'), retryDelayMs);
		if (transient(a)) { unprobed[c.slug] = `HTTP ${a.status}`; continue; }
		if (!a.ok) { excluded[c.slug] = `probe failed (HTTP ${a.status})`; continue; }
		spent += a.cost;
		const b = await withRetry(() => probe(fetchImpl, key, model, c.slug, 'What is 19 times 21? Answer with the number only.'), retryDelayMs);
		if (transient(b)) { unprobed[c.slug] = `HTTP ${b.status}`; continue; }
		if (!b.ok) { excluded[c.slug] = `probe failed (HTTP ${b.status})`; continue; }
		spent += b.cost;
		const clean = !a.textFirst && /^\s*391\s*\.?\s*$/.test(a.text) && !b.textFirst && /^\s*399\s*\.?\s*$/.test(b.text);
		if (!clean) { excluded[c.slug] = 'reasoning leaked into the answer'; continue; }
		const t = await withRetry(() => probeTool(fetchImpl, key, model, c.slug), retryDelayMs);
		spent += t.cost || 0;
		if (transient(t)) { unprobed[c.slug] = `HTTP ${t.status}`; continue; }
		if (!t.ok) { excluded[c.slug] = `tool call failed${t.status ? ` (HTTP ${t.status})` : ''}`; continue; }
		const cacheWorks = b.cacheRead > 0;
		tested.push({ ...c, cacheWorks, score: score(c.price, cacheWorks) });
		log(`qualify ${model}: ${c.slug} ok, cache ${cacheWorks ? 'hit' : 'miss'}`);
	}
	tested.sort((x, y) => x.score - y.score);
	// The router may have demoted a provider while the probes ran (minutes);
	// the store is read again so that rejection survives this write.
	const store = readStore();
	store.models = store.models || {};
	const previous = store.models[model] || {};
	const late = rejectionsFor(model);
	const rejectedAt = {};
	for (const slug of Object.keys(late)) if (previous.rejectedAt && previous.rejectedAt[slug]) rejectedAt[slug] = previous.rejectedAt[slug];
	const entry = {
		at: new Date().toISOString(),
		source: 'probe',
		ranked: tested.map((t) => t.slug).filter((slug) => !late[slug]),
		excluded: { ...excluded, ...late },
		unprobed,
		rejectedAt,
		spent,
	};
	store.models[model] = entry;
	writeStore(store);
	return entry;
}

// The router saw this provider reject a request that the next provider
// served: drop it from the model's ranking on this machine.
function demote(model, slug, reason, now = Date.now()) {
	const store = readStore();
	store.models = store.models || {};
	const current = store.models[model] || (SEED[model] ? { ...SEED[model] } : { at: new Date(now).toISOString(), source: 'price', ranked: [], excluded: {} });
	store.models[model] = {
		...current,
		ranked: (current.ranked || []).filter((s) => s !== slug),
		excluded: { ...(current.excluded || {}), [slug]: reason },
		rejectedAt: { ...(current.rejectedAt || {}), [slug]: new Date(now).toISOString() },
	};
	writeStore(store);
}

// The ranking for a model: this machine's probe result (stale after a week,
// or after a day when some provider only answered 429/5xx), else the seed,
// else the price-only candidate list, always minus providers this machine saw
// reject a request. A seed shipped after the last probe wins over a stale
// probe. Never throws; with an empty list the router refuses the request.
const priceCache = new Map();
async function rankingFor(model, { fetchImpl = globalThis.fetch, ignore = [], now = Date.now() } = {}) {
	const stored = (readStore().models || {})[model];
	const rejected = rejectionsFor(model, now);
	const minus = (r) => ({ ...r, ranked: (r.ranked || []).filter((s) => !rejected[s]), excluded: { ...(r.excluded || {}), ...rejected } });
	const seed = SEED[model];
	if (stored && stored.source === 'probe') {
		const maxAge = stored.unprobed && Object.keys(stored.unprobed).length ? UNPROBED_MAX_AGE_MS : QUALIFY_MAX_AGE_MS;
		const fresh = now - Date.parse(stored.at) < maxAge;
		const own = minus(stored);
		const seedNewer = seed && Date.parse(seed.at) > Date.parse(stored.at);
		if (own.ranked.length && (fresh || !seedNewer)) return { ...own, fresh };
	}
	if (seed) return { ...minus(seed), fresh: false };
	// The price list costs three downloads (one near 1 MB); it is kept for an
	// hour, a failed fetch for ten minutes, so a chat request never waits on it
	// twice.
	const key = `${model}|${[...ignore].sort().join(',')}`;
	const hit = priceCache.get(key);
	if (hit && now < hit.until) return hit.value ? { ...minus(hit.value), fresh: false } : { at: null, source: 'none', ranked: [], excluded: rejected, fresh: false };
	try {
		const { eligible, excluded } = await candidates(model, { fetchImpl, ignore });
		const value = { at: new Date(now).toISOString(), source: 'price', ranked: eligible.map((e) => e.slug), excluded };
		priceCache.set(key, { value, until: now + 3600e3 });
		return { ...minus(value), fresh: false };
	} catch (_) {
		priceCache.set(key, { value: null, until: now + 600e3 });
		return { at: null, source: 'none', ranked: [], excluded: rejected, fresh: false };
	}
}

// What a model reads besides text, from OpenRouter's model card. Cached for a
// day; offline it answers text-only and asks again an hour later.
const infoCache = new Map();
async function modelInfo(model, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
	const hit = infoCache.get(model);
	if (hit && now < hit.until) return hit.info;
	try {
		const body = await getJson(fetchImpl, `${API}/models/${model}/endpoints`);
		const mods = (body && body.data && body.data.architecture && body.data.architecture.input_modalities) || [];
		const info = { images: mods.includes('image'), documents: mods.includes('file') };
		infoCache.set(model, { info, until: now + 24 * 3600e3 });
		return info;
	} catch (_) {
		const info = hit ? hit.info : { images: false, documents: false };
		infoCache.set(model, { info, until: now + 3600e3 });
		return info;
	}
}

module.exports = { candidates, qualify, rankingFor, demote, modelInfo, score, SEED, STORE, EXCLUDED_HQ, LINKED, MIX, REJECT_TTL_MS, _internal: { infoCache, priceCache, listCache, writeStore, readStore, KNOWN_HQ } };
