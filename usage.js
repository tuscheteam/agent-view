const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Remaining-quota lookups for both agents. Neither writes its quota to disk, so
// both of these go out and ask:
//
//   Claude — GET https://api.anthropic.com/api/oauth/usage with the OAuth token
//     Claude Code already stores in ~/.claude/.credentials.json. That endpoint
//     is what `/usage` inside a session reads.
//   Codex  — `codex app-server` over stdio JSON-RPC: initialize, then
//     account/rateLimits/read. The app-server picks up ~/.codex/auth.json
//     itself, so no credential handling here.
//
// Both are read-only and cached, because one spawns a process and the other is
// a network round trip — neither belongs on a tree refresh.

const TTL_MS = 5 * 60 * 1000;
// A failed lookup is not worth holding for the full window: an expired token
// or a dropped connection usually clears in far less than five minutes.
const ERROR_TTL_MS = 60 * 1000;
const CODEX_TIMEOUT_MS = 20000;

// The Claude usage endpoint is rate-limited per account, and Claude Code polls
// the same endpoint from every running chat. One Agent View per VS Code window
// asking every five minutes, retrying a 429 every minute and refetching on
// every token rewrite kept the account limited for hours. So:
//   - every Agent View on this machine shares one lookup through a state file
//     in ~/.agent-view; a lock file (created exclusively, stale after 30 s)
//     lets one window ask while the others read its answer;
//   - an HTTP failure waits for the server's Retry-After, else 2 minutes
//     doubling up to 30. Neither the tick, the refresh button nor a
//     credentials rewrite skips a wait the server imposed;
//   - a failure without an HTTP status (network down, timeout) backs off at
//     most 2 minutes, and the refresh button may retry it at once;
//   - a missing or expired token makes no request and rechecks every minute;
//     a credentials rewrite that brings a different token asks at once;
//   - the last good bars stay on screen while a lookup fails, marked with
//     their age and the next try.
const LEASE_MS = 30 * 1000;
const LOCK_RECHECK_MS = 5 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const BACKOFF_BASE_MS = 2 * 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const NETWORK_BACKOFF_MAX_MS = 2 * 60 * 1000;
const AUTH_RETRY_MS = 60 * 1000;
// No wait runs longer than an hour, whatever Retry-After says; a stored wait
// further out than that (a clock set back, a corrupt file) counts as over.
const MAX_WAIT_MS = 60 * 60 * 1000;

function claudeConfigDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// The state file belongs to one Claude config dir: a window started with a
// different CLAUDE_CONFIG_DIR (another account) keeps its own.
function claudeStateName() {
	if (!process.env.CLAUDE_CONFIG_DIR) return 'claude-usage';
	const key = crypto.createHash('sha256').update(path.resolve(process.env.CLAUDE_CONFIG_DIR).toLowerCase()).digest('hex').slice(0, 10);
	return `claude-usage-${key}`;
}

// A short fingerprint of the stored access token, never the token itself:
// tells a renewed token from the same one written again.
function tokenFingerprint(token) {
	return token ? crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16) : null;
}
function currentTokenId() {
	try {
		const creds = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), '.credentials.json'), 'utf8')).claudeAiOauth;
		return tokenFingerprint(creds && creds.accessToken);
	} catch (_) { return null; }
}

// Retry-After as milliseconds: a number of seconds or an HTTP date.
function retryAfterMs(value, now = Date.now()) {
	if (value === null || value === undefined || value === '') return 0;
	const secs = Number(value);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const at = Date.parse(String(value));
	return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

async function readClaudeUsage(fetchImpl = globalThis.fetch) {
	const file = path.join(claudeConfigDir(), '.credentials.json');
	let creds;
	try {
		creds = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
	} catch (_) {
		return { error: 'no stored Claude credentials', auth: true, local: true, tokenId: null };
	}
	if (!creds || !creds.accessToken) return { error: 'no Claude OAuth token', auth: true, local: true, tokenId: null };
	const tokenId = tokenFingerprint(creds.accessToken);
	if (creds.expiresAt && creds.expiresAt < Date.now()) {
		// The stored token lasts 8 hours and only Claude Code can renew it —
		// it rewrites this file the next time a session runs. Nothing to do
		// here but say so and wait for the file to change; watchCredentials()
		// turns that write into an immediate refetch.
		return { error: 'Claude token expired — runs again once a Claude chat does', auth: true, local: true, tokenId };
	}

	let response;
	try {
		response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				'anthropic-beta': 'oauth-2025-04-20',
				'anthropic-version': '2023-06-01',
			},
			// A hung request must end well inside the 30 s lock.
			signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
		});
	} catch (err) {
		return { error: `usage request failed: ${err.message}`, tokenId };
	}
	if (!response.ok) {
		const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : null;
		return {
			error: `usage request returned ${response.status}`,
			status: response.status,
			retryAfterMs: retryAfterMs(header),
			auth: response.status === 401 || response.status === 403,
			tokenId,
		};
	}

	let body;
	try { body = await response.json(); } catch (_) { return { error: 'unreadable usage response', status: response.status, tokenId }; }
	// A body that does not parse into bars is the server's answer, not a
	// network failure: it takes the HTTP backoff.
	try {
		return { ...claudeBars(body, creds), tokenId };
	} catch (err) {
		return { error: `unreadable usage response: ${err.message}`, status: response.status, tokenId };
	}
}

function claudeBars(body, creds) {
	// `limits` is the labelled view — the same bars claude.ai draws, with the
	// model name supplied by the server. Prefer it: the top-level buckets are
	// rotating codenames (`cinder_cove`, `nimbus_quill`, `tangelo` …) that read
	// null until used, so there is no way to know from them which one is Fable.
	// Here it says so outright: kind `weekly_scoped` carries
	// scope.model.display_name = "Fable".
	if (Array.isArray(body.limits) && body.limits.length) {
		// A scoped limit is one model's own weekly bar ("Fable" and friends).
		// The account-wide bars already carry the number that matters, so the
		// per-model ones stay out of the panel.
		const scoped = body.limits.filter((limit) => limit && limit.scope && limit.scope.model);
		const flat = body.limits.filter((limit) => !(limit && limit.scope && limit.scope.model));
		const windows = (flat.length ? flat : scoped)
			.filter((limit) => limit && typeof limit.percent === 'number')
			.map((limit) => [
				limitLabel(limit),
				{
					pct: limit.percent,
					resetsAt: limit.resets_at ? Date.parse(limit.resets_at) : null,
					severity: limit.severity,
				},
			]);
		return { plan: planLabel(creds), windows };
	}

	// Fallback for accounts or versions that do not return `limits` yet.
	const windows = [];
	for (const [key, raw] of Object.entries(body)) {
		if (key === 'extra_usage' || key === 'limits') continue;
		if (!raw || typeof raw.utilization !== 'number') continue;
		windows.push([
			CLAUDE_WINDOW_LABELS[key] || key.replace(/^seven_day_/, '').replace(/_/g, ' '),
			{ pct: raw.utilization, resetsAt: raw.resets_at ? Date.parse(raw.resets_at) : null },
		]);
	}

	// Shortest window first, so 5h sits above the weekly bars.
	windows.sort((a, b) => (CLAUDE_WINDOW_ORDER.indexOf(a[0]) + 1 || 99) - (CLAUDE_WINDOW_ORDER.indexOf(b[0]) + 1 || 99));

	return { plan: planLabel(creds), windows };
}

// The server names the scoped ones ("Fable"); the two global bars get the short
// labels the row layout is sized for.
function limitLabel(limit) {
	const scoped = limit.scope && limit.scope.model && limit.scope.model.display_name;
	if (scoped) return scoped;
	if (limit.kind === 'session') return '5h';
	if (limit.kind === 'weekly_all') return 'week';
	return String(limit.kind || 'limit').replace(/_/g, ' ');
}

const CLAUDE_WINDOW_LABELS = {
	five_hour: '5h',
	seven_day: 'week',
	seven_day_opus: 'opus',
	seven_day_sonnet: 'sonnet',
	seven_day_oauth_apps: 'apps',
	seven_day_cowork: 'cowork',
};

const CLAUDE_WINDOW_ORDER = ['5h', 'week', 'opus', 'sonnet'];

// Ask VS Code where the ChatGPT extension lives rather than guessing at
// ~/.vscode/extensions. That guess is wrong for Insiders (.vscode-insiders),
// for forks that reuse the extension (Cursor, Windsurf), for portable installs,
// for a custom --extensions-dir, and for remote/WSL/Codespaces, where the
// extension host runs on the remote machine and the local home directory is the
// wrong disk entirely. The API answers correctly in every one of those.
const CODEX_EXTENSION_ID = 'openai.chatgpt';

function codexExtensionRoot() {
	try {
		// Optional dependency: this module is exercised outside VS Code in tests.
		const vscode = require('vscode');
		const found = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
		if (found && found.extensionPath) return [found.extensionPath];
	} catch (_) { /* not running inside the extension host */ }

	// Fallback for the test harness and for the rare case where the extension
	// is installed but not yet visible to the API.
	const roots = [];
	for (const dirName of ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor', '.windsurf']) {
		const root = path.join(os.homedir(), dirName, 'extensions');
		let dirs;
		try { dirs = fs.readdirSync(root).filter((d) => d.startsWith(`${CODEX_EXTENSION_ID}-`)).sort(); } catch (_) { continue; }
		for (const dir of dirs.reverse()) roots.push(path.join(root, dir));
	}
	return roots;
}

// "max" alone does not say which Max: the two tiers differ fivefold in what
// the bars above are a percentage OF. The credentials carry the distinction
// as a rate-limit tier — `default_claude_max_20x` — which is also the
// vocabulary Claude Code itself uses ("Max 20x"). Lowercased here to sit with
// the other plan labels in the panel.
function planLabel(creds) {
	const tier = creds.rateLimitTier;
	if (typeof tier === 'string' && tier) {
		// Anthropic renamed the top plan: the tier is still default_claude_max_20x,
		// the product is Claude Ultra.
		const known = { default_claude_max_20x: 'Ultra', default_claude_max_5x: 'max 5x' };
		if (known[tier]) return known[tier];
		// An unknown tier is still worth showing: strip the prefix the known
		// ones share and let the rest read as-is, rather than falling back to
		// a label that hides the difference.
		const trimmed = tier.replace(/^default_claude_/, '').replace(/_/g, ' ').trim();
		if (trimmed) return trimmed;
	}
	return creds.subscriptionType || null;
}

function codexExecutable() {
	// The binary sits under a platform-named folder that changes with the
	// build (windows-aarch64, darwin-arm64, linux-x64 …), so read the directory
	// instead of composing the name.
	const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
	for (const root of codexExtensionRoot()) {
		const binRoot = path.join(root, 'bin');
		let platforms;
		try { platforms = fs.readdirSync(binRoot); } catch (_) { continue; }
		for (const p of platforms) {
			const exe = path.join(binRoot, p, binary);
			if (fs.existsSync(exe)) return exe;
		}
	}
	return null;
}

function readCodexUsage() {
	const exe = codexExecutable();
	if (!exe) return Promise.resolve({ error: 'codex executable not found' });

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(exe, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (err) {
			resolve({ error: `could not start app-server: ${err.message}` });
			return;
		}

		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { child.kill(); } catch (_) { /* already gone */ }
			resolve(value);
		};
		const timer = setTimeout(() => done({ error: 'app-server timed out' }), CODEX_TIMEOUT_MS);

		child.on('error', (err) => done({ error: err.message }));

		let buffer = '';
		child.stdout.on('data', (chunk) => {
			buffer += chunk.toString();
			let index;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				let message;
				try { message = JSON.parse(line); } catch (_) { continue; }

				if (message.id === 1) {
					send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
				} else if (message.id === 2) {
					if (message.error) { done({ error: message.error.message || 'rateLimits read failed' }); return; }
					done(shapeCodex(message.result));
					return;
				}
			}
		});

		const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) { /* dead */ } };
		send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { clientInfo: { name: 'agent-view', title: 'Agent View', version: '0.9.0' } },
		});
	});
}

function shapeCodex(result) {
	const limits = result && result.rateLimits;
	if (!limits) return { error: 'no rate limits in response' };

	// resetsAt is epoch SECONDS here, unlike Claude's ISO timestamp.
	const window = (raw) => (raw && typeof raw.usedPercent === 'number'
		? {
			pct: raw.usedPercent,
			resetsAt: raw.resetsAt ? raw.resetsAt * 1000 : null,
			label: windowLabel(raw.windowDurationMins),
		}
		: null);

	const windows = [window(limits.primary), window(limits.secondary)].filter(Boolean);
	return {
		plan: limits.planType || null,
		credits: limits.credits && limits.credits.hasCredits ? limits.credits.balance : null,
		windows: windows.map((w) => [w.label, w]),
	};
}

function windowLabel(mins) {
	if (!mins) return 'window';
	if (mins % 10080 === 0) return mins === 10080 ? 'week' : `${mins / 10080}w`;
	if (mins % 1440 === 0) return `${mins / 1440}d`;
	if (mins % 60 === 0) return `${mins / 60}h`;
	return `${mins}m`;
}

// The shared Claude usage state, one small JSON file per Claude config dir:
//   { value: { plan, windows }, lastGoodAt, lastAttemptAt, lastError,
//     lastStatus, auth, tokenId, failures, retryAt }
// next to a lock file that exists while one window is asking.
class ClaudeUsageState {
	constructor(dir) {
		const name = claudeStateName();
		this.file = dir ? path.join(dir, `${name}.json`) : null;
		this.lockFile = dir ? path.join(dir, `${name}.lock`) : null;
		this.memory = {};
		this.mtime = -1;
		// Whether the file existed at the last read or write. Only a file that
		// was there and is gone now resets the state; a directory nobody can
		// write never gets a file, and its in-memory waits must hold.
		this.seen = false;
	}

	read() {
		if (!this.file) return this.memory;
		let stat;
		try {
			stat = fs.statSync(this.file);
		} catch (_) {
			// Deleted since the last read: start over, so removing the file
			// clears a stuck state in running windows too.
			if (this.seen) { this.memory = {}; this.mtime = -1; this.seen = false; }
			return this.memory;
		}
		if (stat.mtimeMs === this.mtime) return this.memory;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (parsed && typeof parsed === 'object') { this.memory = parsed; this.mtime = stat.mtimeMs; this.seen = true; }
		} catch (_) { /* half-written by another window: keep the last read */ }
		return this.memory;
	}

	reread() {
		this.mtime = -1;
		return this.read();
	}

	write(state) {
		this.memory = state;
		if (!this.file) return;
		const tmp = `${this.file}.${process.pid}.tmp`;
		const text = JSON.stringify(state);
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(tmp, text);
		} catch (_) {
			try { fs.unlinkSync(tmp); } catch (_) { /* never written */ }
			return; // the in-memory state still serves this window
		}
		// Windows refuses the rename (EPERM, EBUSY, EACCES) while another
		// window has the file open for its read. A refused write would leave
		// the other windows on the old state, and one of them would ask again.
		let written = false;
		for (let attempt = 0; attempt < 5 && !written; attempt++) {
			try {
				fs.renameSync(tmp, this.file);
				written = true;
			} catch (err) {
				if (!err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
			}
		}
		if (!written) {
			try { fs.writeFileSync(this.file, text); written = true; } catch (_) { /* memory only */ }
			try { fs.unlinkSync(tmp); } catch (_) { /* renamed after all */ }
		}
		if (!written) return;
		try { this.mtime = fs.statSync(this.file).mtimeMs; this.seen = true; } catch (_) { /* read() catches up */ }
	}

	// The lock is a file created exclusively: of several windows, exactly one
	// creation succeeds. A lock older than LEASE_MS belongs to a window that
	// died or reloaded mid-request and is taken over.
	lock(owner) {
		if (!this.lockFile) return true;
		try { fs.mkdirSync(path.dirname(this.lockFile), { recursive: true }); } catch (_) { /* reported by openSync */ }
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = fs.openSync(this.lockFile, 'wx');
				try { fs.writeSync(fd, owner); } finally { fs.closeSync(fd); }
				return true;
			} catch (err) {
				// A directory nobody can write: no window can share anything,
				// so each one asks on its own schedule and backoff.
				if (!err || err.code !== 'EEXIST') return true;
				let stat;
				try { stat = fs.statSync(this.lockFile); } catch (_) { continue; }
				if (Date.now() - stat.mtimeMs < LEASE_MS) return false;
				try { fs.unlinkSync(this.lockFile); } catch (_) { /* another window took it over */ }
			}
		}
		return false;
	}

	unlock(owner) {
		if (!this.lockFile) return;
		try {
			if (fs.readFileSync(this.lockFile, 'utf8') === owner) fs.unlinkSync(this.lockFile);
		} catch (_) { /* already gone */ }
	}
}

// The stored shape the panel expects. Bumped when the bars or the plan text
// changed, so a cached value from an older version is rewritten rather than
// shown as it was.
const USAGE_VALUE_VERSION = 2;
const ACCOUNT_WINDOW = new Set(['5h', 'week', 'opus', 'sonnet', 'apps', 'cowork', 'oauth apps']);

function normalizeClaudeValue(value) {
	if (!value || typeof value !== 'object') return value;
	const plan = value.plan === 'max 20x' ? 'Ultra' : value.plan;
	const windows = Array.isArray(value.windows) ? value.windows.filter((w) => ACCOUNT_WINDOW.has(String(w && w[0]))) : [];
	return { ...value, plan, windows: windows.length ? windows : value.windows || [], v: USAGE_VALUE_VERSION };
}

function backoffMs(failures, cap = BACKOFF_MAX_MS) {
	const base = Math.min(cap, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
	// A little jitter keeps several machines on one account from lining up.
	return Math.round(base * (0.9 + Math.random() * 0.2));
}

// One cache per provider: served immediately, refreshed in the background when
// stale so the tree never waits on a network call or a process spawn. Claude
// goes through the shared state above; Codex asks its local app-server.
class UsageCache {
	constructor(onChange, log, options = {}) {
		this.onChange = onChange;
		this.log = log || (() => {});
		this.entries = { claude: null, codex: null };
		this.inFlight = {};
		this.now = options.now || Date.now;
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.claudeState = new ClaudeUsageState(options.stateDir === undefined ? path.join(os.homedir(), '.agent-view') : options.stateDir);
		this.owner = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
	}

	get(provider) {
		if (provider === 'claude') {
			const st = this.claudeState.read();
			if (this._claudeDue(st, 'tick')) this._refreshClaude('tick');
			return this._claudeView(this.claudeState.read());
		}
		const entry = this.entries[provider];
		const ttl = entry && entry.value && entry.value.error ? ERROR_TTL_MS : TTL_MS;
		if (!entry || Date.now() - entry.at > ttl) this._refresh(provider);
		return entry ? entry.value : null;
	}

	// Look a provider up again now. For Claude this is the credentials watcher:
	// it asks at once only to fix an authentication problem with a token that
	// differs from the one that failed. Claude Code rewrites that file far more
	// often than the usage changes, and a rate-limit wait is never skipped.
	invalidate(provider) {
		if (provider === 'claude') {
			if (this._claudeDue(this.claudeState.read(), 'credentials')) this._refreshClaude('credentials');
			return;
		}
		this.entries[provider] = null;
		this._refresh(provider);
	}

	// The refresh button: Codex asks again; Claude asks again unless the
	// server asked us to wait.
	refreshAll() {
		this.entries.codex = null;
		this._refresh('codex');
		const st = this.claudeState.read();
		if (this._claudeDue(st, 'refresh')) this._refreshClaude('refresh');
		else if (this.onChange) this.onChange();
	}

	// A wait still running, or 0. Beyond MAX_WAIT_MS it counts as over.
	_pendingWait(st) {
		const now = this.now();
		const at = Number(st.retryAt) || 0;
		return at > now && at - now <= MAX_WAIT_MS ? at : 0;
	}

	// mode: 'tick' (a render), 'refresh' (the button), 'credentials' (the
	// credentials file changed).
	_claudeDue(st, mode) {
		const now = this.now();
		if (this.inFlight.claude) return false;
		if (mode === 'credentials') return !!st.auth && currentTokenId() !== (st.tokenId || null);
		if (this._pendingWait(st)) return mode === 'refresh' && !st.lastStatus;
		if (mode === 'refresh') return true;
		const good = Number(st.lastGoodAt) || 0;
		return !(good && good <= now && now - good < TTL_MS);
	}

	// What the panel shows: the last good bars, marked stale while lookups
	// fail; an error alone only when there never was a good answer.
	_claudeView(st) {
		const pending = this._pendingWait(st) || null;
		if (st.value && st.value.v !== USAGE_VALUE_VERSION) {
			// A value stored before the panel dropped model-scoped bars would
			// keep one on screen for the whole rate-limit wait. Normalise it
			// once and write it back.
			st = { ...st, value: normalizeClaudeValue(st.value) };
			this.claudeState.write(st);
		}
		if (st.value) {
			if (!st.lastError) return st.value;
			return { ...st.value, stale: { since: st.lastGoodAt || null, error: st.lastError, status: st.lastStatus || null, auth: !!st.auth, retryAt: pending } };
		}
		if (st.lastError) return { error: st.lastError, status: st.lastStatus || null, auth: !!st.auth, retryAt: pending };
		return null;
	}

	_refreshClaude(mode) {
		if (this.inFlight.claude) return;
		if (!this.claudeState.lock(this.owner)) {
			// Another window is asking. Look again in a few seconds, so this
			// panel shows that window's answer without waiting for the next
			// minute tick.
			if (!this.lockRetry && this.onChange) {
				this.lockRetry = setTimeout(() => { this.lockRetry = null; this.onChange(); }, LOCK_RECHECK_MS);
				if (this.lockRetry.unref) this.lockRetry.unref();
			}
			return;
		}
		// Re-read under the lock: another window may have just answered.
		const before = this.claudeState.reread();
		if (!this._claudeDue(before, mode)) { this.claudeState.unlock(this.owner); return; }
		const startedAt = Date.now();
		this.inFlight.claude = Promise.resolve()
			.then(() => readClaudeUsage(this.fetchImpl))
			.catch((err) => ({ error: err && err.message ? err.message : String(err) }))
			.then((value) => {
				const st = this.claudeState.reread();
				const now = this.now();
				const result = value || { error: 'no answer' };
				let next;
				if (!result.error) {
					const { tokenId, ...bars } = result;
					next = { value: { ...bars, v: USAGE_VALUE_VERSION }, lastGoodAt: now, lastAttemptAt: now, lastError: null, lastStatus: null, auth: false, tokenId: tokenId || null, failures: 0, retryAt: 0 };
				} else if (result.local) {
					// No request went out: recheck the token in a minute, and
					// leave the backoff count to real requests.
					next = { ...st, lastAttemptAt: now, lastError: result.error, lastStatus: null, auth: true, tokenId: result.tokenId || null, retryAt: now + AUTH_RETRY_MS };
				} else {
					// Only server answers grow the count: a long offline stretch
					// must not turn the first 429 after it into a 30-minute wait.
					const failures = (Number(st.failures) || 0) + (result.status ? 1 : 0);
					const backoff = result.status ? backoffMs(failures) : backoffMs(1, NETWORK_BACKOFF_MAX_MS);
					const wait = Math.min(MAX_WAIT_MS, Math.max(result.retryAfterMs || 0, backoff));
					next = { ...st, lastAttemptAt: now, lastError: result.error, lastStatus: result.status || null, auth: !!result.auth, tokenId: result.tokenId || null, failures, retryAt: now + wait };
				}
				delete next.lease;
				this.claudeState.write(next);
				const took = Date.now() - startedAt;
				this.log(`claude usage: ${result.error ? `ERROR ${result.error}, next try in ${Math.round((next.retryAt - now) / 60000)}m` : `${(next.value.windows || []).length} window(s)`} (${took}ms)`);
			})
			.catch((err) => this.log(`claude usage: bookkeeping failed: ${err && err.message ? err.message : err}`))
			.finally(() => {
				this.claudeState.unlock(this.owner);
				delete this.inFlight.claude;
				if (this.onChange) this.onChange();
			});
	}

	_refresh(provider) {
		if (provider !== 'codex' || this.inFlight[provider]) return;
		const read = readCodexUsage;
		const startedAt = Date.now();
		this.inFlight[provider] = Promise.resolve()
			.then(read)
			.catch((err) => ({ error: err && err.message ? err.message : String(err) }))
			.then((value) => {
				this.entries[provider] = { at: Date.now(), value };
				delete this.inFlight[provider];
				const took = Date.now() - startedAt;
				this.log(`${provider} usage: ${value && value.error ? `ERROR ${value.error}` : `${(value && value.windows || []).length} window(s)`} (${took}ms)`);
				if (this.onChange) this.onChange();
			});
	}
}

function formatReset(ms) {
	if (!ms) return null;
	const mins = Math.round((ms - Date.now()) / 60000);
	if (mins <= 0) return 'due';
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

// Claude Code rewrites ~/.claude/.credentials.json every time it renews the
// token. Watching the directory rather than the file survives an atomic
// write, where the old inode is replaced and a file watcher would go deaf.
function watchCredentials(onChange) {
	try {
		const watcher = fs.watch(claudeConfigDir(), (_event, name) => {
			if (name && String(name).includes('.credentials.json')) onChange();
		});
		return { dispose: () => watcher.close() };
	} catch (_) {
		return { dispose: () => {} };
	}
}

module.exports = { UsageCache, formatReset, planLabel, readClaudeUsage, readCodexUsage, codexExecutable, watchCredentials, retryAfterMs, tokenFingerprint };
