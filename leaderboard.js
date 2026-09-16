const API_BASE = 'https://aistupidlevel.info/api/v1';
const SECRET_KEY = 'openEditorsTools.aslApiKey';
const CACHE_KEY = 'openEditorsTools.aslLeaderboardCache';
const REFRESH_HOURS = [8, 11, 14, 17, 20];
const REQUEST_SPACING_MS = 65000;
const TIMER_MAX_MS = 24 * 60 * 60 * 1000;
const ALLOWED_PROVIDERS = new Set(['openai', 'anthropic']);

class LeaderboardCache {
	constructor(context, onChange, log, options = {}) {
		this.context = context;
		this.onChange = onChange || (() => {});
		this.log = log || (() => {});
		this.now = options.now || (() => new Date());
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.spacingMs = options.spacingMs === undefined ? REQUEST_SPACING_MS : options.spacingMs;
		this.cache = context.globalState.get(CACHE_KEY) || emptyCache();
		this.inFlight = false;
		this.timer = null;
	}

	dispose() {
		if (this.timer) clearTimeout(this.timer);
	}

	start() {
		this._scheduleTimer();
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
		return this.refreshNow({ reason, slotKey });
	}

	async refreshNow({ reason = 'manual', slotKey = slotKeyFor(this.now()) || manualSlotKey(this.now()) } = {}) {
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
			const reasoning = await fetchModels(this.fetchImpl, key, 'reasoning');
			this.cache = { ...this.cache, reasoning, lastError: null };
			await this._save();
			this._notify();
			if (this.spacingMs > 0) await this.sleep(this.spacingMs);

			const coding = await fetchModels(this.fetchImpl, key, 'coding');
			this.cache = {
				...this.cache,
				coding,
				lastSlotKey: slotKey,
				lastSuccessAt: this.now().toISOString(),
				lastError: null,
			};
			await this._save();
			this.log(`ASL leaderboard refresh complete (${reason}, slot=${slotKey})`);
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
	_internal: {
		API_BASE,
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
