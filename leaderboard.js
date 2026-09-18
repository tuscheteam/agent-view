const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://aistupidlevel.info/api/v1';
const SECRET_KEY = 'openEditorsTools.aslApiKey';
const CACHE_KEY = 'openEditorsTools.aslLeaderboardCache';
const REFRESH_HOURS = [8, 11, 14, 17, 20];
// The site's CODING tab is its "speed" key, which its own frontend rewrites to
// sortBy=7axis before every request. sortBy=coding is accepted by the API too
// but returns the COMBINED numbers — the column showed gpt-5.5 at 86 while the
// site's CODING tab said 91.
const CODING_SORT = '7axis';
const REQUEST_SPACING_MS = 65000;
const TIMER_MAX_MS = 24 * 60 * 60 * 1000;
const ALLOWED_PROVIDERS = new Set(['openai', 'anthropic']);
// Flagship models are priced for the orchestrator seat, not for fan-out, so
// they never win the subagent recommendation even when they top the board.
const DEFAULT_SUBAGENT_EXCLUDE = ['claude-fable-5-1', 'gpt-6-astra'];
const RECOMMENDATION_DIR = '.agent-view';
const RECOMMENDATION_FILE = 'subagent-recommendation.json';

class LeaderboardCache {
	constructor(context, onChange, log, options = {}) {
		this.context = context;
		this.onChange = onChange || (() => {});
		this.log = log || (() => {});
		this.now = options.now || (() => new Date());
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.spacingMs = options.spacingMs === undefined ? REQUEST_SPACING_MS : options.spacingMs;
		// Where the subagent recommendation file lands; tests point this at a
		// temp dir instead of the real home so a run leaves the home alone.
		this.homeDir = options.homeDir || os.homedir();
		// The exclude list arrives as a plain array (excludedModels) or as a
		// getter (getExcluded) the caller re-reads each write, so a settings
		// change lands on the next refresh without reloading the extension.
		this.excludedModels = options.excludedModels;
		this.getExcluded = typeof options.getExcluded === 'function' ? options.getExcluded : null;
		this.cache = context.globalState.get(CACHE_KEY) || emptyCache();
		// A coding column cached under another mode is wrong data with a right
		// label; an empty column until the next fetch is the honest state.
		if (this.cache.coding && this.cache.coding.sortBy !== CODING_SORT) {
			this.cache = { ...this.cache, coding: null };
		}
		this.inFlight = false;
		this.timer = null;
	}

	dispose() {
		if (this.timer) clearTimeout(this.timer);
	}

	start() {
		this._scheduleTimer();
		// A cached coding column from a previous session is enough to hand the
		// orchestrators a recommendation immediately, before the first refresh.
		if (this.cache && this.cache.coding) this.writeRecommendation(this.cache);
		this.maybeRefresh('startup');
	}

	getSnapshot() {
		return {
			...this.cache,
			hasKey: false,
			inFlight: this.inFlight,
			currentSlot: slotKeyFor(this.now()),
			nextRefreshAt: nextRefreshAt(this.now()).toISOString(),
		};
	}

	async hasKey() {
		return Boolean(await this.context.secrets.get(SECRET_KEY));
	}

	async maybeRefresh(reason) {
		const slotKey = slotKeyFor(this.now());
		if (!slotKey) {
			this._scheduleTimer();
			this._notify();
			return false;
		}
		if (this.cache.lastSlotKey === slotKey && this.cache.reasoning && this.cache.coding) {
			this._scheduleTimer();
			this._notify();
			return false;
		}
		// Only the coding column missing for this slot (it was just dropped as
		// stale): one call instead of two, the free tier has ten a day.
		const codingOnly = this.cache.lastSlotKey === slotKey && Boolean(this.cache.reasoning) && !this.cache.coding;
		return this.refreshNow({ reason, slotKey, codingOnly });
	}

	async refreshNow({ reason = 'manual', slotKey = slotKeyFor(this.now()) || manualSlotKey(this.now()), codingOnly = false } = {}) {
		if (this.inFlight) return false;
		const key = await this.context.secrets.get(SECRET_KEY);
		if (!key) {
			this.cache = {
				...this.cache,
				lastError: 'Set an AI Stupid Level API key to refresh the leaderboard.',
				lastAttemptAt: this.now().toISOString(),
			};
			await this._save();
			this._notify();
			this._scheduleTimer();
			return false;
		}
		if (typeof this.fetchImpl !== 'function') {
			this.cache = {
				...this.cache,
				lastError: 'This VS Code runtime does not provide fetch().',
				lastAttemptAt: this.now().toISOString(),
			};
			await this._save();
			this._notify();
			this._scheduleTimer();
			return false;
		}

		this.inFlight = true;
		this.cache = {
			...this.cache,
			lastAttemptAt: this.now().toISOString(),
			lastReason: reason,
			lastError: null,
		};
		await this._save();
		this._notify();
		this.log(`ASL leaderboard refresh started (${reason}, slot=${slotKey})`);

		try {
			if (!codingOnly) {
				const reasoning = await fetchModels(this.fetchImpl, key, 'reasoning');
				this.cache = { ...this.cache, reasoning, lastError: null };
				await this._save();
				this._notify();
				if (this.spacingMs > 0) await this.sleep(this.spacingMs);
			}

			const coding = await fetchModels(this.fetchImpl, key, CODING_SORT);
			this.cache = {
				...this.cache,
				coding,
				lastSlotKey: slotKey,
				lastSuccessAt: this.now().toISOString(),
				lastError: null,
			};
			await this._save();
			this.log(`ASL leaderboard refresh complete (${reason}, slot=${slotKey})`);
			this.writeRecommendation(this.cache);
			return true;
		} catch (err) {
			this.cache = {
				...this.cache,
				lastError: err && err.message ? err.message : String(err),
				lastErrorAt: this.now().toISOString(),
			};
			await this._save();
			this.log(`ASL leaderboard refresh failed: ${this.cache.lastError}`);
			return false;
		} finally {
			this.inFlight = false;
			this._notify();
			this._scheduleTimer();
		}
	}

	async setApiKey(key) {
		const trimmed = String(key || '').trim();
		if (!trimmed) return false;
		await this.context.secrets.store(SECRET_KEY, trimmed);
		this.cache = { ...this.cache, lastError: null };
		await this._save();
		this._notify();
		this.refreshNow({ reason: 'key-set' });
		return true;
	}

	async clearApiKey() {
		await this.context.secrets.delete(SECRET_KEY);
		this.cache = {
			...this.cache,
			lastError: 'AI Stupid Level API key removed.',
			lastAttemptAt: this.now().toISOString(),
		};
		await this._save();
		this._notify();
	}

	async _save() {
		await this.context.globalState.update(CACHE_KEY, this.cache);
	}

	_notify() {
		this.onChange();
	}

	// Re-read the exclude list at write time: a getter wins over the fixed
	// array, and the built-in default fills in when neither was supplied.
	_resolveExcluded(options = {}) {
		if (typeof options.getExcluded === 'function') return options.getExcluded();
		if (this.getExcluded) return this.getExcluded();
		if (Array.isArray(options.excludedModels)) return options.excludedModels;
		if (Array.isArray(this.excludedModels)) return this.excludedModels;
		return DEFAULT_SUBAGENT_EXCLUDE;
	}

	// Drop the best coding pick per provider into ~/.agent-view so a Claude Code
	// or Codex orchestrator can read one file and choose its subagent model. A
	// write failure is logged and swallowed; a missing file just means no pick
	// yet, never a broken refresh.
	writeRecommendation(cache, options = {}) {
		const coding = cache && cache.coding;
		if (!coding || !Array.isArray(coding.rows)) return false;
		const excluded = this._resolveExcluded(options);
		const { claude, codex } = recommendSubagents(coding, excluded);
		const payload = {
			generatedAt: coding.generatedAt || null,
			writtenAt: this.now().toISOString(),
			source: 'aistupidlevel.info (sortBy=7axis coding board)',
			excluded,
			claude,
			codex,
			note: 'Best-scoring coding model per provider, flagships excluded. Orchestrators: pass claude.model / codex.model as the subagent model.',
		};
		const homeDir = options.homeDir || this.homeDir;
		const dir = path.join(homeDir, RECOMMENDATION_DIR);
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, RECOMMENDATION_FILE), `${JSON.stringify(payload, null, 2)}\n`);
			return true;
		} catch (err) {
			this.log(`subagent recommendation write failed: ${err && err.message ? err.message : String(err)}`);
			return false;
		}
	}

	_scheduleTimer() {
		if (this.timer) clearTimeout(this.timer);
		const ms = Math.max(1000, Math.min(TIMER_MAX_MS, nextRefreshAt(this.now()).getTime() - this.now().getTime() + 1000));
		this.timer = setTimeout(() => this.maybeRefresh('schedule'), ms);
	}
}

async function fetchModels(fetchImpl, key, sortBy) {
	const url = `${API_BASE}/models?period=latest&sortBy=${encodeURIComponent(sortBy)}`;
	let response;
	try {
		response = await fetchImpl(url, {
			headers: {
				Authorization: `Bearer ${key}`,
				Accept: 'application/json',
			},
		});
	} catch (err) {
		throw new Error(`${sortBy} request failed: ${err.message}`);
	}

	let body = null;
	try { body = await response.json(); } catch (_) { /* shaped below */ }
	if (!response.ok) {
		const code = body && (body.code || body.error || body.message);
		throw new Error(`${sortBy} request returned ${response.status}${code ? ` (${code})` : ''}`);
	}
	if (!body || body.success !== true || !Array.isArray(body.data)) {
		throw new Error(`${sortBy} response did not contain a data array`);
	}

	return {
		sortBy,
		period: body.period || 'latest',
		generatedAt: body.generated_at || body.generatedAt || new Date().toISOString(),
		count: body.count || body.data.length,
		quota: quotaFromHeaders(response.headers),
		rows: shapeRows(body.data),
	};
}

function shapeRows(data) {
	return data
		.map((item, index) => {
			const provider = normalizeProvider(item.provider);
			return {
				id: String(item.id || item.modelId || item.name || index),
				name: String(item.name || item.model || item.id || 'unknown'),
				provider,
				rank: Number(item.rank || item.currentRank || index + 1),
				score: scoreOf(item),
				trend: String(item.trend || item.direction || ''),
				status: String(item.status || item.band || ''),
				lastUpdated: item.lastUpdated || item.updated_at || item.generated_at || null,
				confidenceLower: numericOrNull(item.confidenceLower),
				confidenceUpper: numericOrNull(item.confidenceUpper),
			};
		})
		.filter((item) => ALLOWED_PROVIDERS.has(item.provider));
}

function scoreOf(item) {
	for (const key of ['currentScore', 'score', 'combinedScore', 'value']) {
		const value = numericOrNull(item[key]);
		if (value !== null) return value;
	}
	return null;
}

function numericOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function normalizeProvider(provider) {
	const value = String(provider || '').trim().toLowerCase();
	if (value === 'openai' || value === 'open ai') return 'openai';
	if (value === 'anthropic' || value === 'claude') return 'anthropic';
	return value;
}

function quotaFromHeaders(headers) {
	if (!headers || typeof headers.get !== 'function') return null;
	return {
		limit: headers.get('x-ratelimit-limit'),
		remaining: headers.get('x-ratelimit-remaining'),
		reset: headers.get('x-ratelimit-reset'),
	};
}

function slotKeyFor(date) {
	const d = new Date(date);
	const hour = d.getHours();
	const slot = [...REFRESH_HOURS].reverse().find((h) => hour >= h);
	if (slot === undefined) return null;
	return `${localDateKey(d)}-${String(slot).padStart(2, '0')}`;
}

function manualSlotKey(date) {
	const d = new Date(date);
	return `${localDateKey(d)}-manual-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function localDateKey(date) {
	const d = new Date(date);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextRefreshAt(date) {
	const d = new Date(date);
	for (const hour of REFRESH_HOURS) {
		const candidate = new Date(d);
		candidate.setHours(hour, 0, 0, 0);
		if (candidate > d) return candidate;
	}
	const tomorrow = new Date(d);
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(REFRESH_HOURS[0], 0, 0, 0);
	return tomorrow;
}

// Pick the best coding model per provider that no one excluded. Highest score
// wins; a tie breaks to the better (lower) rank. Returns raw model names, which
// are already real ids the orchestrators pass straight through.
function recommendSubagents(codingColumn, excluded) {
	const rows = codingColumn && Array.isArray(codingColumn.rows) ? codingColumn.rows : [];
	const blocked = buildExcludeSet(excluded);
	const best = { anthropic: null, openai: null };
	for (const row of rows) {
		if (!row || !row.name) continue;
		if (row.provider !== 'anthropic' && row.provider !== 'openai') continue;
		if (blocked.has(normalizeModelName(row.name))) continue;
		const score = Number(row.score);
		if (!Number.isFinite(score)) continue;
		const rank = Number(row.rank);
		const current = best[row.provider];
		if (!current || score > current._score || (score === current._score && rank < current._rank)) {
			best[row.provider] = { model: row.name, score: row.score, rank: row.rank, _score: score, _rank: rank };
		}
	}
	return { claude: pickRecommendation(best.anthropic), codex: pickRecommendation(best.openai) };
}

function pickRecommendation(entry) {
	if (!entry) return null;
	return { model: entry.model, score: entry.score, rank: entry.rank };
}

// A name matches an exclude entry with or without its "claude-" prefix, so a
// user can write "fable-5-1" and still block "claude-fable-5-1".
function normalizeModelName(name) {
	let value = String(name || '').trim().toLowerCase();
	if (value.startsWith('claude-')) value = value.slice('claude-'.length);
	return value;
}

function buildExcludeSet(excluded) {
	const set = new Set();
	for (const entry of Array.isArray(excluded) ? excluded : []) {
		const name = normalizeModelName(entry);
		if (name) set.add(name);
	}
	return set;
}

function emptyCache() {
	return {
		reasoning: null,
		coding: null,
		lastSlotKey: null,
		lastSuccessAt: null,
		lastAttemptAt: null,
		lastError: null,
	};
}

module.exports = {
	LeaderboardCache,
	fetchModels,
	shapeRows,
	slotKeyFor,
	nextRefreshAt,
	recommendSubagents,
	DEFAULT_SUBAGENT_EXCLUDE,
	_internal: {
		API_BASE,
		CODING_SORT,
		SECRET_KEY,
		CACHE_KEY,
		REFRESH_HOURS,
		REQUEST_SPACING_MS,
		ALLOWED_PROVIDERS,
		emptyCache,
		normalizeProvider,
		manualSlotKey,
	},
};
