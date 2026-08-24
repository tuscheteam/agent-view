const fs = require('fs');
const os = require('os');
const path = require('path');
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

function claudeConfigDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function readClaudeUsage() {
	const file = path.join(claudeConfigDir(), '.credentials.json');
	let creds;
	try {
		creds = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
	} catch (_) {
		return { error: 'no stored Claude credentials' };
	}
	if (!creds || !creds.accessToken) return { error: 'no Claude OAuth token' };
	if (creds.expiresAt && creds.expiresAt < Date.now()) {
		// The stored token lasts 8 hours and only Claude Code can renew it —
		// it rewrites this file the next time a session runs. Nothing to do
		// here but say so and wait for the file to change; watchCredentials()
		// turns that write into an immediate refetch.
		return { error: 'Claude token expired — runs again once a Claude chat does' };
	}

	let response;
	try {
		response = await fetch('https://api.anthropic.com/api/oauth/usage', {
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				'anthropic-beta': 'oauth-2025-04-20',
				'anthropic-version': '2023-06-01',
			},
		});
	} catch (err) {
		return { error: `usage request failed: ${err.message}` };
	}
	if (!response.ok) return { error: `usage request returned ${response.status}` };

	let body;
	try { body = await response.json(); } catch (_) { return { error: 'unreadable usage response' }; }

	// `limits` is the labelled view — the same bars claude.ai draws, with the
	// model name supplied by the server. Prefer it: the top-level buckets are
	// rotating codenames (`cinder_cove`, `nimbus_quill`, `tangelo` …) that read
	// null until used, so there is no way to know from them which one is Fable.
	// Here it says so outright: kind `weekly_scoped` carries
	// scope.model.display_name = "Fable".
	if (Array.isArray(body.limits) && body.limits.length) {
		const windows = body.limits
			.filter((limit) => limit && typeof limit.percent === 'number')
			.map((limit) => [
				limitLabel(limit),
				{
					pct: limit.percent,
					resetsAt: limit.resets_at ? Date.parse(limit.resets_at) : null,
					severity: limit.severity,
				},
			]);
		return { plan: creds.subscriptionType || null, windows };
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

	return { plan: creds.subscriptionType || null, windows };
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

// One cache per provider: served immediately, refreshed in the background when
// stale so the tree never waits on a network call or a process spawn.
class UsageCache {
	constructor(onChange, log) {
		this.onChange = onChange;
		this.log = log || (() => {});
		this.entries = { claude: null, codex: null };
		this.inFlight = {};
	}

	get(provider) {
		const entry = this.entries[provider];
		const ttl = entry && entry.value && entry.value.error ? ERROR_TTL_MS : TTL_MS;
		if (!entry || Date.now() - entry.at > ttl) this._refresh(provider);
		return entry ? entry.value : null;
	}

	// Drop what is cached for one provider and look it up again now.
	invalidate(provider) {
		this.entries[provider] = null;
		this._refresh(provider);
	}

	refreshAll() {
		this.entries = { claude: null, codex: null };
		this._refresh('claude');
		this._refresh('codex');
	}

	_refresh(provider) {
		if (this.inFlight[provider]) return;
		const read = provider === 'claude' ? readClaudeUsage : readCodexUsage;
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

module.exports = { UsageCache, formatReset, readClaudeUsage, readCodexUsage, codexExecutable, watchCredentials };
