const fs = require('fs');
const os = require('os');
const path = require('path');
const { tokenFingerprint, claudeBars, retryAfterMs } = require('./usage');

// Claude account switching, the vscode-free half. Opt-in through
// openEditorsTools.accounts.enabled; the panel is accountsView.js.
//
// A second Claude subscription runs every chat on this machine through a
// long-lived token from `claude setup-token`, written as
// env.CLAUDE_CODE_OAUTH_TOKEN into Claude Code's user settings. Measured with
// Claude Code 2.1.322 (2026-11-11):
//   - the token there replaces the /login account (a wrong one fails with 401);
//   - while it is set, the session-owner check ("This session belongs to
//     another account") has no current account to compare, so existing chats
//     continue on the new account instead of offering only a copy;
//   - removing it brings back the /login account.
// Chats, skills, settings and memory stay in the one config dir.
//
// Tokens from setup-token are inference-only. Checked here without spending
// usage: POST /v1/messages/count_tokens answers 200 for a good token and names
// the organization in anthropic-organization-id. The usage endpoint may refuse
// such a token, so the weekly figure also comes from the
// anthropic-ratelimit-unified-* headers the router sees on every reply
// (utilization is a fraction, reset is epoch seconds; measured 0.34 /
// 1794888000 on 2026-11-11).

const API = 'https://api.anthropic.com';
const BETA = 'oauth-2025-04-20';
const TOKEN_HEAD = 'sk-ant-oat01-';
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const FETCH_TIMEOUT_MS = 15 * 1000;
// What the router saw last, per token fingerprint. Shared by every window.
const OBSERVED_FILE = path.join(os.homedir(), '.agent-view', 'account-usage.json');

function configDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
	return path.join(configDir(), 'settings.json');
}
function globalConfigPath() {
	return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// The token Claude Code currently runs on from its settings, or null for the
// /login account. Unreadable settings read as "no token": the panel then says
// the login account is active, which is what Claude Code does with them too.
function activeToken(file = settingsPath()) {
	try {
		const env = readJson(file).env;
		const t = env && env.CLAUDE_CODE_OAUTH_TOKEN;
		return typeof t === 'string' && t ? t : null;
	} catch (_) { return null; }
}

// Put a token into the settings env block, or take it out (token = null).
// Everything else in the file stays as it was. A file that does not parse is
// left alone and the call throws: rewriting it would drop the user's settings.
// A symlinked settings file is written at its target. The temp file holds the
// token, so it is created owner-only and never left behind.
function writeActiveToken(token, file = settingsPath()) {
	let target = file;
	try { target = fs.realpathSync(file); } catch (_) { /* not there yet */ }
	let settings = {};
	let mode = 0o600;
	let exists = true;
	try { mode = fs.statSync(target).mode & 0o777; } catch (_) { exists = false; }
	if (exists) settings = readJson(target);
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${file} does not hold a JSON object`);
	const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
	if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
	else delete env.CLAUDE_CODE_OAUTH_TOKEN;
	if (Object.keys(env).length) settings.env = env; else delete settings.env;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const text = `${JSON.stringify(settings, null, 2)}\n`;
	const tmp = `${target}.agent-view-${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, text, { mode });
		// Windows refuses the rename (EPERM, EBUSY, EACCES) while Claude Code
		// or a scanner has the file open; same retry as usage.js.
		for (let attempt = 0; ; attempt++) {
			try { fs.renameSync(tmp, target); return; } catch (err) {
				if (attempt >= 5 || !err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
			}
		}
	} finally {
		try { fs.unlinkSync(tmp); } catch (_) { /* renamed */ }
	}
}

// The account /login signed in with, as Claude Code records it.
function loginAccount(file = globalConfigPath()) {
	try {
		const a = readJson(file).oauthAccount;
		if (!a || !a.accountUuid) return null;
		return { email: a.emailAddress || null, orgId: a.organizationUuid || null, accountUuid: a.accountUuid };
	} catch (_) { return null; }
}

function stripAnsi(text) {
	return String(text)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[()][0-9A-Za-z]/g, '');
}

// Token candidates in terminal output, longest first. A token printed in a
// narrow terminal wraps, so a line break followed by more token characters may
// or may not belong to it ("Store this token..." starts with letters too); the
// caller checks each candidate against the server and keeps the first that
// works.
function tokenCandidates(output) {
	const text = stripAnsi(output);
	const found = [];
	let from = 0;
	for (;;) {
		const at = text.indexOf(TOKEN_HEAD, from);
		if (at < 0) break;
		from = at + TOKEN_HEAD.length;
		let i = from;
		let token = TOKEN_HEAD;
		const cuts = [];
		for (let joins = 0; joins <= 3;) {
			while (i < text.length && TOKEN_CHAR.test(text[i])) token += text[i++];
			cuts.push(token);
			// Continue only across one line break plus indentation.
			let j = i;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
			if (text[j] === '\r') j++;
			if (text[j] !== '\n') break;
			j++;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
			if (!TOKEN_CHAR.test(text[j] || '')) break;
			i = j;
			joins++;
		}
		for (const c of cuts.reverse()) if (c.length > TOKEN_HEAD.length + 20 && !found.includes(c)) found.push(c);
	}
	return found;
}

function timeoutSignal() {
	return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

// Does the token work, and which organization is it? Free: count_tokens spends
// no usage. Resolves { ok, status, orgId } and never throws.
async function checkToken(token, fetchImpl = globalThis.fetch) {
	try {
		const res = await fetchImpl(`${API}/v1/messages/count_tokens`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] }),
			signal: timeoutSignal(),
		});
		const orgId = res.headers && typeof res.headers.get === 'function' ? res.headers.get('anthropic-organization-id') : null;
		return { ok: res.status === 200, status: res.status, orgId: orgId || null };
	} catch (err) {
		return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
	}
}

// The check that cannot disagree with Claude Code: one short `claude -p` turn
// with the token as CLAUDE_CODE_OAUTH_TOKEN. A setup-token carries only the
// user:inference scope. On 2026-11-23 the add flow refused a fresh one twice
// (read from the terminal and pasted) while count_tokens above accepted /login
// tokens, so count_tokens alone never refuses a token. User settings are left
// out (--setting-sources project, run in the temp dir): their env block may
// hold the token of the account in use, which would win over this one. No MCP
// servers start and no session file is written. Costs one tiny turn on that
// account. A timeout or an aborted signal kills the run and resolves at once.
// Resolves { ok, status, error } and never throws.
function checkTokenWithClaude(token, exe, { timeoutMs = 60000, spawnImpl, signal } = {}) {
	return new Promise((resolve) => {
		let settled = false;
		let child = null;
		let timer = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', onAbort);
			resolve(result);
		};
		const stopChild = () => { try { if (child) child.kill(); } catch (_) { /* gone */ } };
		const onAbort = () => { stopChild(); finish({ ok: false, status: 0, error: 'cancelled' }); };
		if (signal && signal.aborted) { finish({ ok: false, status: 0, error: 'cancelled' }); return; }
		// Only Anthropic may see the token: no proxy, gateway or cloud route the
		// host environment points Claude Code at.
		const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
		for (const name of Object.keys(env)) {
			if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|BEDROCK_|VERTEX_|FOUNDRY_)/.test(name) || /^CLAUDE_CODE_USE_/.test(name)) delete env[name];
		}
		try {
			child = (spawnImpl || require('child_process').spawn)(exe || 'claude',
				['-p', 'Reply with just: ok', '--model', 'haiku', '--output-format', 'json', '--setting-sources', 'project',
					'--strict-mcp-config', '--no-session-persistence'],
				{ cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (err) { finish({ ok: false, status: 0, error: err.message }); return; }
		let out = '';
		let errOut = '';
		timer = setTimeout(() => { stopChild(); finish({ ok: false, status: 0, error: `no answer within ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
		if (signal) signal.addEventListener('abort', onAbort);
		child.stdout.on('data', (d) => { out += d; });
		if (child.stderr) child.stderr.on('data', (d) => { errOut += d; });
		child.on('error', (err) => finish({ ok: false, status: 0, error: err.message }));
		child.on('close', (code) => {
			let j = null;
			try { j = JSON.parse(String(out).trim().split('\n').pop()); } catch (_) { j = null; }
			const ok = code === 0 && j && j.is_error === false;
			const text = j && typeof j.result === 'string' ? j.result : String(out || errOut).slice(0, 300) || `exit code ${code}`;
			finish({ ok: !!ok, status: ok ? 200 : cliStatus(text), error: ok ? null : text.replace(/sk-ant-\S+/g, '<token>').slice(0, 200) });
		});
	});
}

// The HTTP status behind a failed `claude -p` answer: 401 also for the
// wordings Claude Code uses for a dead login, 0 when the text names none.
function cliStatus(text) {
	if (/\b401\b|authentication_error|failed to authenticate|invalid (api key|bearer|oauth|access token|token)|token (has )?expired|expired token|revoked|please run \/login/i.test(text)) return 401;
	if (/\b403\b|permission_error|forbidden/i.test(text)) return 403;
	if (/\b429\b|rate_limit/i.test(text)) return 429;
	return 0;
}

// Email and plan when the token may read the profile; a setup-token usually
// may not, and then this resolves null.
async function profileOf(token, fetchImpl = globalThis.fetch) {
	try {
		const res = await fetchImpl(`${API}/api/oauth/profile`, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA }, signal: timeoutSignal() });
		if (res.status !== 200) return null;
		const body = await res.json();
		if (!body || !body.account) return null;
		const org = body.organization || {};
		return { email: body.account.email || null, orgId: org.uuid || null, plan: org.plan_display_name || null };
	} catch (_) { return null; }
}

// The usage endpoint with this token. { windows } on success; { status } when
// the server refused (a setup-token's scope, or a rate limit).
async function usageOf(token, fetchImpl = globalThis.fetch) {
	try {
		const res = await fetchImpl(`${API}/api/oauth/usage`, {
			headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA, 'anthropic-version': '2023-06-01' },
			signal: timeoutSignal(),
		});
		if (res.status !== 200) {
			const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
			return { status: res.status, retryAfterMs: retryAfterMs(header) };
		}
		const bars = claudeBars(await res.json(), {});
		return { windows: bars.windows, at: Date.now() };
	} catch (err) {
		return { status: 0, error: err && err.message ? err.message : String(err) };
	}
}

// The unified rate-limit headers of one reply as usage windows, or null when
// the reply carried none. Utilization arrives as a fraction of 1.
function windowsFromHeaders(headers) {
	const get = (name) => {
		const v = headers[name];
		return Array.isArray(v) ? v[0] : v;
	};
	const windows = [];
	for (const [key, label] of [['5h', '5h'], ['7d', 'week']]) {
		const raw = get(`anthropic-ratelimit-unified-${key}-utilization`);
		const u = raw === undefined || raw === null || String(raw).trim() === '' ? NaN : Number(raw);
		if (!Number.isFinite(u)) continue;
		const reset = Number(get(`anthropic-ratelimit-unified-${key}-reset`));
		windows.push([label, { pct: Math.round(u * 100), resetsAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null, status: get(`anthropic-ratelimit-unified-${key}-status`) || null }]);
	}
	if (!windows.length) return null;
	return { windows, status: get('anthropic-ratelimit-unified-status') || null };
}

function bearerOf(headers) {
	const auth = headers && (headers.authorization || headers.Authorization);
	const m = /^Bearer\s+(\S+)/i.exec(String(auth || ''));
	return m ? m[1] : null;
}

function readObserved(file = OBSERVED_FILE) {
	try {
		const j = readJson(file);
		return j && typeof j === 'object' ? j : {};
	} catch (_) { return {}; }
}

// Called by the router for every Claude reply with an OAuth bearer, keyed by
// the token's fingerprint (never the token). The /login access token carries
// the same sk-ant-oat01- prefix but rotates every few hours, so its entries
// pile up: entries older than 8 days go, and at most 20 stay.
const OBSERVED_KEEP_MS = 8 * 24 * 3600 * 1000;
// About 24 /login tokens rotate through in 8 days; 64 keeps an idle added
// account's last figure alive for the whole week.
const OBSERVED_KEEP_N = 64;
function recordObserved(requestHeaders, responseHeaders, file = OBSERVED_FILE, now = Date.now()) {
	const token = bearerOf(requestHeaders);
	if (!token || !token.startsWith(TOKEN_HEAD)) return false;
	const seen = windowsFromHeaders(responseHeaders || {});
	if (!seen) return false;
	const id = tokenFingerprint(token);
	const all = readObserved(file);
	// One write per minute per token is plenty; a busy chat answers far more often.
	const prev = all[id];
	if (prev && now - (prev.at || 0) < 60 * 1000 && JSON.stringify(prev.windows) === JSON.stringify(seen.windows)) return false;
	all[id] = { at: now, windows: seen.windows, status: seen.status };
	const kept = Object.entries(all)
		.filter(([, v]) => v && now - (v.at || 0) < OBSERVED_KEEP_MS)
		.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
		.slice(0, OBSERVED_KEEP_N);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
		fs.renameSync(tmp, file);
		return true;
	} catch (_) { return false; }
}

// A window whose reset time has passed is empty again.
function settleWindows(windows, now = Date.now()) {
	return (windows || []).map(([label, w]) => (w && w.resetsAt && w.resetsAt <= now ? [label, { ...w, pct: 0, resetsAt: null, status: null }] : [label, w]));
}

// The first window that says the account cannot take more work until its
// reset, as [label, window], or null.
function spentWindow(windows) {
	return (windows || []).find(([, w]) => w && (w.status === 'rejected' || Number(w.pct) >= 100)) || null;
}
function isExhausted(windows) {
	return !!spentWindow(windows);
}

// Where Agent View notes which token it put into the settings, by
// fingerprint, so an uninstall removes only an entry this extension wrote.
const WRITTEN_FILE = path.join(os.homedir(), '.agent-view', 'accounts-written.json');
function noteWritten(token, file = WRITTEN_FILE) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ tokenId: token ? tokenFingerprint(token) : null, at: Date.now() }));
	} catch (_) { /* uninstall then leaves the entry for the user */ }
}
function wroteToken(token, file = WRITTEN_FILE) {
	try { return !!token && readJson(file).tokenId === tokenFingerprint(token); } catch (_) { return false; }
}

module.exports = {
	TOKEN_HEAD, OBSERVED_FILE,
	settingsPath, activeToken, writeActiveToken, loginAccount,
	stripAnsi, tokenCandidates, checkToken, checkTokenWithClaude, cliStatus, profileOf, usageOf,
	windowsFromHeaders, bearerOf, readObserved, recordObserved, settleWindows, isExhausted, spentWindow,
	WRITTEN_FILE, noteWritten, wroteToken,
};
