const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');
const { tokenFingerprint } = require('./usage');
const { usageRow, usageRules, escapeHtml, CLAUDE_FILL } = require('./usageView');

// The Accounts panel (opt-in: openEditorsTools.accounts.enabled). One row for
// the /login account, one per added Claude account, each with its weekly bar.
// Use, Rename and Remove sit in a row's context menu; Add, the name blur and
// Refresh in the panel title. Mechanism and measurements: accounts.js.
//
// Tokens sit in VS Code's SecretStorage (the OS credential store). The token
// in use is also written to Claude Code's settings, because that is where
// Claude Code reads it.

const LIST_KEY = 'openEditorsTools.claudeAccounts';
const SWITCHED_KEY = 'openEditorsTools.claudeAccounts.switchedAt';
const NOTIFIED_KEY = 'openEditorsTools.claudeAccounts.limitNotified';
const SECRET_PREFIX = 'openEditorsTools.claudeAccount.';
const NAMES_HIDDEN_KEY = 'openEditorsTools.claudeAccounts.namesHidden';
// The context key that swaps the eye in the panel title (package.json menus).
const NAMES_HIDDEN_CONTEXT = 'openEditorsTools.accountNamesHidden';
const USAGE_TTL_MS = 10 * 60 * 1000;
// A setup-token is inference-only; the usage endpoint refusing it is the
// normal case, not a fault worth asking again about every ten minutes.
const REFUSED_RETRY_MS = 6 * 60 * 60 * 1000;
const RATE_RETRY_MS = 15 * 60 * 1000;
const SETUP_WAIT_MS = 10 * 60 * 1000;
const SHELL_WAIT_MS = 8 * 1000;
const AUTH_REFUSED = (status) => status === 401 || status === 403;

class AccountStore {
	constructor(context) {
		this.context = context;
	}
	list() {
		const v = this.context.globalState.get(LIST_KEY);
		return Array.isArray(v) ? v.filter((a) => a && a.id) : [];
	}
	async save(list) {
		await this.context.globalState.update(LIST_KEY, list);
	}
	token(id) {
		return this.context.secrets.get(SECRET_PREFIX + id);
	}
	// The entry a token belongs to without asking: the same token, or the
	// same email when Anthropic told us one. Same organization alone is no
	// proof (a Team org holds several people), so the caller asks then.
	match(entry) {
		return this.list().find((a) => a.tokenId === entry.tokenId || (entry.email && a.email && a.email === entry.email)) || null;
	}
	sameOrg(entry) {
		return entry.orgId ? this.list().find((a) => a.orgId === entry.orgId) || null : null;
	}
	// replaceId: the entry to renew; null adds a new one. The secret is
	// written first: when the credential store refuses, nothing changes.
	async put(entry, token, replaceId = null) {
		const list = this.list();
		const same = replaceId ? list.find((a) => a.id === replaceId) || null : null;
		const id = same ? same.id : crypto.randomBytes(6).toString('hex');
		await this.context.secrets.store(SECRET_PREFIX + id, token);
		const next = { ...(same || {}), ...entry, id, name: (same && same.name) || entry.name };
		await this.save(same ? list.map((a) => (a.id === id ? next : a)) : list.concat(next));
		return { entry: next, replaced: same };
	}
	async remove(id) {
		await this.context.secrets.delete(SECRET_PREFIX + id);
		await this.save(this.list().filter((a) => a.id !== id));
	}
}

class AccountsViewProvider {
	constructor(context, usage, log) {
		this.context = context;
		this.usage = usage;
		this.log = log || (() => {});
		this.store = new AccountStore(context);
		this.view = null;
		this.startedAt = Date.now();
		// Per account id: { windows, at } from the usage endpoint, or the
		// time it may be asked again after a refusal ({ retryAt, refused }).
		this.fetched = new Map();
		this.fetching = new Set();
		this.busy = null;
		// The account a busy text names; {name} in this.busy stands for it.
		this.busyName = null;
		// The row that holds keyboard focus in the page, kept for the next
		// repaint. Memory only: a window reload starts without it.
		this.focusId = null;
		this.cancelAdd = null;
		this.lastHtml = null;
	}

	enabled() {
		return vscode.workspace.getConfiguration('openEditorsTools').get('accounts.enabled', false);
	}

	resolveWebviewView(webviewView) {
		this.view = webviewView;
		this.lastHtml = null;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.onDidReceiveMessage((msg) => this._onMessage(msg));
		webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.render(); });
		webviewView.onDidDispose(() => { this.view = null; this.lastHtml = null; });
		this.render();
	}

	// The account in use and its rows: shared by the panel, the Usage bars and
	// the limit notice.
	async snapshot() {
		const list = this.store.list();
		const activeToken = accounts.activeToken();
		const activeTokenId = activeToken ? tokenFingerprint(activeToken) : null;
		const observed = accounts.readObserved();
		const login = accounts.loginAccount();
		const rows = [];
		let loginUsage = this.usage.get('claude');
		// Only Claude Code renews the /login token, and it does not while an
		// added account runs the chats: the expiry note would blame the wrong thing.
		if (activeToken && loginUsage && loginUsage.error && loginUsage.auth) loginUsage = { error: 'Usage shows again once chats run on this account.' };
		rows.push({
			kind: 'login',
			id: 'login',
			name: login && login.email ? login.email : 'Claude login',
			plan: loginUsage && !loginUsage.error ? loginUsage.plan || null : null,
			active: !activeToken,
			usage: loginUsage,
		});
		for (const a of list) {
			rows.push({
				kind: 'token',
				id: a.id,
				name: a.name || a.email || 'Claude account',
				plan: a.plan || null,
				active: !!activeTokenId && a.tokenId === activeTokenId,
				usage: this._tokenUsage(a, observed),
			});
		}
		const unknownActive = !!activeToken && !rows.some((r) => r.active);
		return { rows, unknownActive, switchedAt: this.context.globalState.get(SWITCHED_KEY) || 0 };
	}

	// Newest of what the router saw and what the usage endpoint said; nothing
	// known yet reads as a note, not as an error.
	_tokenUsage(a, observed) {
		const seen = observed[a.tokenId];
		const asked = this.fetched.get(a.id);
		const pick = [seen, asked && asked.windows ? asked : null].filter(Boolean).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
		this._maybeFetch(a);
		if (pick) return { plan: '', windows: accounts.settleWindows(pick.windows), at: pick.at };
		const routerOn = vscode.workspace.getConfiguration('openEditorsTools').get('modelRouter.enabled', false);
		if (asked && asked.refused && !routerOn) return { error: 'No weekly figure: Anthropic refuses the usage lookup for this token, and the model router (Agent View setting) is off.' };
		return { error: 'Weekly use shows once this account has answered a chat.' };
	}

	_maybeFetch(a) {
		const now = Date.now();
		const prev = this.fetched.get(a.id);
		if (this.fetching.has(a.id)) return;
		if (prev && prev.retryAt && prev.retryAt > now) return;
		if (prev && prev.windows && now - prev.at < USAGE_TTL_MS) return;
		this.fetching.add(a.id);
		(async () => {
			const token = await this.store.token(a.id);
			if (!token) return;
			const r = await accounts.usageOf(token);
			if (r.windows) {
				this.fetched.set(a.id, { windows: r.windows, at: r.at });
				this.render();
				return;
			}
			const refused = AUTH_REFUSED(r.status);
			const wait = refused ? REFUSED_RETRY_MS : r.status === 429 ? Math.max(r.retryAfterMs || 0, RATE_RETRY_MS) : RATE_RETRY_MS;
			this.fetched.set(a.id, { ...(prev && prev.windows ? prev : {}), retryAt: now + wait, refused });
			this.log(`accounts: usage for ${a.name} not readable (${r.status || r.error}), next try in ${Math.round(wait / 60000)}m`);
			if (refused) this.render();
		})().catch((err) => this.log(`accounts: usage lookup failed: ${err && err.message ? err.message : err}`))
			.finally(() => this.fetching.delete(a.id));
	}

	// What the Usage bars show for Claude while an added account is in use:
	// that account's figure, labelled with its name. null = the /login bars.
	// Not tied to the setting: chats run on that account until it is removed
	// from Claude Code's settings, and the bars must say so.
	claudeOverride() {
		const token = accounts.activeToken();
		if (!token) return null;
		const id = tokenFingerprint(token);
		const a = this.store.list().find((x) => x.tokenId === id);
		if (!a) return null;
		const u = this._tokenUsage(a, accounts.readObserved());
		// The Usage panel has no blur: with names hidden it says which kind of account.
		const name = this.namesHidden() ? 'Added account' : a.name;
		return u.error ? { error: `${name}: ${u.error}` } : { ...u, plan: name };
	}

	// The name a toast or dialog may show. With names hidden: the number the
	// panel's screen-reader labels use (Account 1 is the /login account).
	_shown(id, name) {
		if (!this.namesHidden()) return name;
		if (id === 'login') return 'Account 1';
		const i = this.store.list().findIndex((x) => x.id === id);
		return i >= 0 ? `Account ${i + 2}` : 'this account';
	}

	// Use, Rename and Remove from the row's context menu. VS Code hands the
	// command the row's data-vscode-context.
	async fromMenu(cmd, ctx) {
		const id = ctx && typeof ctx.accountId === 'string' ? ctx.accountId : null;
		if (!id) return;
		if (this.busy) {
			vscode.window.showInformationMessage('Agent View: wait until the account is added.');
			return;
		}
		await this._onMessage({ cmd, id });
	}

	render() {
		if (!this.view) return;
		this.snapshot().then((snap) => {
			if (!this.view) return;
			const html = this._html(snap);
			// A fresh nonce on every paint would reset focus and swallow a
			// click every minute; repaint only when something changed.
			// The focus note alone never causes a repaint.
			const key = html.replace(/nonce-[^']+'|nonce="[^"]+"| data-restore-focus="[^"]*"/g, '');
			if (key !== this.lastHtml) {
				this.lastHtml = key;
				this.view.webview.html = html;
			}
			this._limitNotice(snap).catch((err) => this.log(`accounts: limit notice failed: ${err && err.message ? err.message : err}`));
		}).catch((err) => {
			this.log(`accounts: render failed: ${err && err.stack ? err.stack : err}`);
			try {
				this.lastHtml = null;
				this.view.webview.html = `<!DOCTYPE html><html><body style="font:12px var(--vscode-font-family);color:var(--vscode-errorForeground);padding:8px">Accounts could not be drawn: ${escapeHtml(String(err && err.message ? err.message : err))}</body></html>`;
			} catch (_) { /* view gone */ }
		});
	}

	// The eye in the panel title: names (email addresses) blurred, for a screen
	// that others see. Kept across reloads until it is turned off again.
	namesHidden() {
		return !!this.context.globalState.get(NAMES_HIDDEN_KEY);
	}

	async setNamesHidden(hidden) {
		await this.context.globalState.update(NAMES_HIDDEN_KEY, !!hidden);
		await vscode.commands.executeCommand('setContext', NAMES_HIDDEN_CONTEXT, !!hidden);
		this.render();
	}

	_html(snap) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		const widths = new Set();
		const busy = !!this.busy;
		const dis = busy ? ' disabled' : '';
		const hidden = this.namesHidden();
		// A hidden name never reaches the page: its shape (length, @ and dots)
		// is drawn blurred, so the real text cannot be read back from the pixels.
		const who = (name) => (hidden ? `<span class="masked">${escapeHtml(maskName(name))}</span>` : escapeHtml(name));
		const active = snap.rows.find((r) => r.active);
		const spent = active && active.usage && !active.usage.error ? accounts.spentWindow(active.usage.windows) : null;
		const notices = [];
		// {name} in a busy text is filled at paint time, so the eye also hides
		// a name in a notice that was already on screen.
		if (busy) notices.push(`<div class="notice"><p>${escapeHtml(this.busy).replace('{name}', () => who(this.busyName || 'this account'))}</p>${this.cancelAdd ? '<button class="pill" data-cmd="cancel">Cancel</button>' : ''}</div>`);
		if (snap.unknownActive) notices.push(`<div class="notice warn"><p>Claude Code runs on an account that is not in this list (a token set in its settings by hand or by another tool).</p><button class="pill" data-cmd="import"${dis}>Add that account to the list</button></div>`);
		if (spent) {
			const free = snap.rows.find((r) => !r.active && !(r.usage && !r.usage.error && accounts.isExhausted(r.usage.windows)));
			const what = spent[0] === 'week' ? 'weekly' : escapeHtml(spent[0]);
			notices.push(free
				? `<div class="notice warn"><p>${who(active.name)} has reached its ${what} limit.</p><button class="pill" data-cmd="use" data-id="${escapeHtml(free.id)}"${hidden ? '' : ` title="Use ${escapeHtml(free.name)}"`}${dis}>Use ${who(free.name)}</button></div>`
				: `<p class="notice warn">${who(active.name)} has reached its ${what} limit, and no other account in this list has room left.</p>`);
		}
		if (snap.switchedAt > this.startedAt && active) {
			notices.push(`<div class="notice"><p>New chats run on ${who(active.name)}. Open chats keep the account they started on until the window reloads; reloading stops replies that are still running.</p><button class="pill" data-cmd="reload">Reload Window</button></div>`);
		}
		const rows = snap.rows.map((r, i) => {
			// The head names the plan only. The account in use is the row with
			// the Claude rule; Use, Rename and Remove sit in its context menu.
			const plan = r.plan || (r.usage && !r.usage.error && r.usage.plan) || '';
			const usage = r.usage && !r.usage.error ? { ...r.usage, plan } : r.usage;
			let bars = usageRow(who(r.name), 'claude', usage, widths);
			if (!hidden) bars = bars.replace('<span class="uname">', () => `<span class="uname" title="${escapeHtml(r.name)}">`);
			// An error row has no plan slot of its own.
			if (plan && (!usage || usage.error)) bars = bars.replace('</span></div>', () => `</span><span class="sub">${escapeHtml(plan)}</span></div>`);
			const menu = { webviewSection: 'account', accountId: r.id, accountKind: r.kind, accountActive: !!r.active, accountsBusy: busy, preventDefaultContextMenuItems: true };
			const label = hidden ? `Account ${i + 1}` : r.name;
			return `<section class="acct${r.active ? ' active' : ''}" data-id="${escapeHtml(r.id)}" tabindex="0" aria-label="${escapeHtml(label)}${r.active ? ', in use' : ''}${plan ? `, ${escapeHtml(plan)}` : ''}"${r.active ? ' aria-current="true"' : ''} data-vscode-context="${escapeHtml(JSON.stringify(menu))}">
${bars}
</section>`;
		}).join('\n');
		const widthRules = [...widths].map((w) => `.usage .w${w} { width: ${w}%; }`).join('\n\t');
		const restoreFocus = this.focusId && snap.rows.some((r) => r.id === this.focusId) ? ` data-restore-focus="${escapeHtml(this.focusId)}"` : '';
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	body {
		padding: 10px 12px;
		margin: 0;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
	}
	${usageRules()}
	.usage .head .uname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.usage .head .sub { flex: none; }
	/* One list row per account, as in VS Code's own trees: hover and focus
	   show the row that the context menu acts on. The 2px rule on the left
	   is transparent except on the account in use, where it carries Claude's
	   fill (the colour of the bars). */
	.acct {
		display: block;
		margin: 0 -12px;
		padding: 6px 12px 6px 10px;
		border-left: 2px solid transparent;
		outline: none;
	}
	.acct + .acct { margin-top: 2px; }
	.acct:hover { background: var(--vscode-list-hoverBackground); }
	.acct:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.acct.active { border-left-color: ${CLAUDE_FILL}; }
	/* A hidden name: its blurred shape, never its text. */
	.masked { filter: blur(4px); user-select: none; }
	/* The notice buttons: VS Code's secondary button colours on a pill, at the
	   panel's 24px control height (radius = half the height). */
	button {
		font-family: inherit;
		font-size: inherit;
		line-height: 18px;
		padding: 2px 12px;
		border-radius: 12px;
		border: 1px solid var(--vscode-contrastBorder, transparent);
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		cursor: pointer;
	}
	/* A long address in "Use <account>" ends in an ellipsis on one line. */
	button { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
	button:disabled { opacity: 0.6; cursor: default; }
	.notice { margin: 0 0 12px; }
	.notice p { margin: 0 0 6px; }
	/* Warning text stays in the foreground colour (the warning yellow reads
	   2.9:1 on a light theme); the yellow marks the notice beside it. */
	.notice.warn { border-left: 2px solid var(--vscode-editorWarning-foreground); padding-left: 10px; margin-left: -12px; }
	${widthRules}
</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems":true}'${restoreFocus}>
${notices.join('\n')}
<div class="usage">
${rows}
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', (e) => {
		const b = e.target.closest('button[data-cmd]');
		if (!b || b.disabled) return;
		vscode.postMessage({ cmd: b.dataset.cmd, id: b.dataset.id || null });
	});
	// A repaint replaces the page. The extension keeps the row that holds
	// keyboard focus and names it in the next page (data-restore-focus), so
	// Shift+F10 still opens its menu. A mouse click, focus that left the
	// panel, or a window reload (the extension starts empty) restores nothing.
	const restore = document.body.dataset.restoreFocus;
	if (restore) {
		const row = document.querySelector('section[data-id="' + CSS.escape(restore) + '"]');
		if (row) row.focus({ focusVisible: true });
	}
	document.addEventListener('focusin', (e) => {
		const row = e.target.closest ? e.target.closest('section[data-id]') : null;
		vscode.postMessage({ cmd: 'focus', id: row && row.matches(':focus-visible') ? row.dataset.id : null });
	});
	document.addEventListener('focusout', (e) => { if (!e.relatedTarget) vscode.postMessage({ cmd: 'focus', id: null }); });
</script>
</body>
</html>`;
	}

	async _onMessage(msg) {
		if (!msg || typeof msg.cmd !== 'string') return;
		// The row with keyboard focus, for the next repaint (no repaint now).
		if (msg.cmd === 'focus') { this.focusId = typeof msg.id === 'string' ? msg.id : null; return; }
		try {
			if (msg.cmd === 'cancel') { if (this.cancelAdd) this.cancelAdd(); return; }
			if (msg.cmd === 'reload') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
			if (this.busy) return;
			if (msg.cmd === 'add') await vscode.commands.executeCommand('openEditorsTools.addClaudeAccount');
			else if (msg.cmd === 'use') await this.use(msg.id);
			else if (msg.cmd === 'remove') await this.remove(msg.id);
			else if (msg.cmd === 'rename') await this.rename(msg.id);
			else if (msg.cmd === 'import') await this.importActive();
		} catch (err) {
			this.log(`accounts: ${msg.cmd} failed: ${err && err.stack ? err.stack : err}`);
			vscode.window.showErrorMessage(`Agent View: ${err && err.message ? err.message : err}`);
		}
	}

	async use(id) {
		// The limit notice can call this while an add runs; that add owns the panel.
		if (this.busy) {
			vscode.window.showInformationMessage('Agent View: finish adding the account first, then choose Use This Account again.');
			return;
		}
		let name;
		let token = null;
		if (id === 'login') {
			const login = accounts.loginAccount();
			name = this._shown('login', login && login.email ? login.email : 'the /login account');
		} else {
			const a = this.store.list().find((x) => x.id === id);
			if (!a) return;
			name = this._shown(id, a.name);
			token = await this.store.token(id);
			if (!token) throw new Error(`The token of ${name} is missing from the credential store. Remove the account and add it again.`);
			// Only a refusal blocks: a rate limit or an outage of the check must
			// not keep anyone on the account that just ran out.
			let check = await accounts.checkToken(token);
			if (AUTH_REFUSED(check.status)) {
				// count_tokens may turn down a valid setup-token: Claude Code decides.
				this.busy = 'Checking the token of {name} with Claude Code.';
				this.busyName = a.name;
				this.render();
				try { check = await accounts.checkTokenWithClaude(token, claudeExecutable()); } finally { this.busy = null; this.busyName = null; this.render(); }
				if (AUTH_REFUSED(check.status)) throw new Error(`Anthropic refused the token of ${name} (HTTP ${check.status}). Add the account again to get a fresh token.`);
				// Turned down by count_tokens and no clear answer from Claude Code:
				// the user decides. A rate limit means the token itself works.
				if (!check.ok && check.status !== 429) {
					const go = await vscode.window.showWarningMessage(
						`Claude Code could not confirm the token of ${name} (${check.error || 'no answer'}). Switch anyway?`,
						{ modal: true }, 'Switch');
					if (go !== 'Switch') return;
				}
			}
			if (!check.ok) this.log(`accounts: token check for ${a.name} inconclusive (${check.status || check.error}), switching anyway`);
		}
		const current = accounts.activeToken();
		const known = !current || this.store.list().some((a) => a.tokenId === tokenFingerprint(current));
		if (!known && current !== token) {
			const pick = await vscode.window.showWarningMessage(
				'Claude Code runs on a token that is not in the Accounts list. Switching removes it from Claude Code\u2019s settings, and Agent View keeps no copy.',
				{ modal: true }, 'Add It to the List First', 'Replace It');
			if (!pick) return;
			if (pick === 'Add It to the List First' && !(await this.importActive())) return;
		}
		accounts.writeActiveToken(token);
		accounts.noteWritten(token);
		await this.context.globalState.update(SWITCHED_KEY, Date.now());
		this.log(`accounts: switched to ${name}`);
		this.render();
		const choice = await vscode.window.showInformationMessage(
			`New Claude chats run on ${name}. Open chats keep their previous account until the window reloads; reloading stops replies that are still running.`,
			'Reload Window');
		if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}

	async remove(id) {
		const a = this.store.list().find((x) => x.id === id);
		if (!a) return;
		const active = accounts.activeToken();
		const inUse = !!active && tokenFingerprint(active) === a.tokenId;
		const ok = await vscode.window.showWarningMessage(
			`Remove ${this._shown(id, a.name)} from Agent View?${inUse ? ' Claude Code goes back to the /login account.' : ''} The token itself stays valid for its year; to revoke it, sign out of that session in the account's claude.ai settings.`,
			{ modal: true }, 'Remove');
		if (ok !== 'Remove') return;
		if (inUse) {
			accounts.writeActiveToken(null);
			accounts.noteWritten(null);
			await this.context.globalState.update(SWITCHED_KEY, Date.now());
		}
		await this.store.remove(id);
		this.fetched.delete(id);
		this.render();
	}

	async rename(id) {
		const a = this.store.list().find((x) => x.id === id);
		if (!a) return;
		// With names hidden the box starts empty: the old name would show in it.
		const hidden = this.namesHidden();
		const name = await vscode.window.showInputBox({
			title: `Rename ${this._shown(id, a.name)}`,
			value: hidden ? '' : a.name,
			password: hidden,
			prompt: hidden ? 'Account names are hidden. The new name stays hidden while you type it.' : undefined,
			validateInput: (v) => (v.trim() ? null : 'A name is needed'),
		});
		if (!name || !name.trim()) return;
		await this.store.save(this.store.list().map((x) => (x.id === id ? { ...x, name: name.trim() } : x)));
		this.render();
	}

	// The token Claude Code runs on but the list does not hold: store it, so a
	// switch never destroys the only copy. Resolves true when stored.
	async importActive() {
		const token = accounts.activeToken();
		if (!token || this.store.list().some((a) => a.tokenId === tokenFingerprint(token))) return true;
		const saved = await this._store(token, await accounts.checkToken(token));
		return !!saved;
	}

	// "Add account": runs `claude setup-token` in a terminal, reads the token
	// from its output, checks it with Anthropic and stores it. Without shell
	// integration the token is pasted into a password box instead. The
	// terminal (with the token on screen) closes only once the token is stored
	// or the user gave up.
	async add() {
		if (this.busy) return;
		const terminal = vscode.window.createTerminal({ name: 'Claude: add account', iconPath: new vscode.ThemeIcon('key') });
		terminal.show();
		const command = setupTokenCommand(claudeExecutable(), vscode.env.shell);
		let closeTerminal = true;
		let cancelled = false;
		let terminalOpen = true;
		// Cancel ends the wait for the sign-in and kills a running token check.
		const abort = new AbortController();
		let cancel = null;
		const stop = new Promise((resolve) => {
			const timer = setTimeout(() => resolve('timeout'), SETUP_WAIT_MS);
			const sub = vscode.window.onDidCloseTerminal((t) => { if (t === terminal) { terminalOpen = false; resolve('closed'); } });
			cancel = () => { abort.abort(); resolve('cancelled'); };
			this._stopCleanup = () => { clearTimeout(timer); sub.dispose(); };
		});
		const status = (text, cancellable) => {
			this.busy = text;
			this.cancelAdd = cancellable ? cancel : null;
			this.render();
		};
		status('Sign in in the browser with the account you want to add. Agent View reads the token from the terminal.', true);
		try {
			const shell = await Promise.race([waitForShellIntegration(terminal, SHELL_WAIT_MS), stop.then(() => null)]);
			const log = (m) => this.log(m);
			const signal = abort.signal;
			const checking = () => status('Checking the token with Claude Code. This takes a few seconds.', true);
			let found = null;
			if (shell) {
				let output = '';
				const run = shell.executeCommand(command);
				const reading = (async () => { for await (const chunk of run.read()) output += chunk; return 'ended'; })();
				const why = await Promise.race([reading, stop]);
				cancelled = why === 'cancelled' || why === 'closed';
				if (!cancelled) {
					const candidates = accounts.tokenCandidates(output);
					if (candidates.length) checking();
					const r = await pickToken(candidates, { log, signal });
					if (r.token) found = r;
					cancelled = signal.aborted;
					this.log(`accounts: setup-token ${why}, ${found ? (found.check.ok ? 'token found' : 'token found, not verified') : `no usable token in the output (${r.why})`}`);
				}
			} else {
				terminal.sendText(command);
				this.log('accounts: no shell integration, the token is pasted by hand');
			}
			if (!found && !cancelled) {
				// The box has its own Escape; a Cancel button in the panel could not close it.
				status('Paste the token into the box at the top of the window.', false);
				const pasted = await vscode.window.showInputBox({
					title: 'Add Claude account',
					prompt: 'Sign in in the browser, then paste the token that "claude setup-token" printed (sk-ant-oat01-...).',
					password: true,
					ignoreFocusOut: true,
				});
				if (pasted) {
					const candidates = accounts.tokenCandidates(pasted);
					if (candidates.length) checking();
					const r = await pickToken(candidates, { log, signal });
					if (r.token) found = r;
					cancelled = signal.aborted;
					if (!found && !cancelled) vscode.window.showErrorMessage(`Agent View could not use the pasted text (${r.why}). Nothing was stored${terminalOpen ? '; the token stays in the terminal for another try' : ''}.`);
				}
			}
			if (found) {
				const saved = await this._store(found.token, found.check);
				if (!saved) closeTerminal = false;
			} else if (!cancelled) {
				// The token may be on screen there and nowhere else.
				closeTerminal = false;
			}
		} catch (err) {
			// The token may still be on screen there: keep it for a manual retry.
			closeTerminal = false;
			throw err;
		} finally {
			if (this._stopCleanup) this._stopCleanup();
			this.cancelAdd = null;
			if (closeTerminal) terminal.dispose();
			this.busy = null;
			this.render();
		}
	}

	// Name and store a checked token. Resolves the stored entry, or null when
	// the user stopped or the credential store refused.
	async _store(token, check) {
		if (!check.ok) {
			const go = await vscode.window.showWarningMessage(
				`Anthropic could not confirm this token right now (${check.status ? `HTTP ${check.status}` : check.error || 'no answer'}). Store it anyway?`,
				{ modal: true }, 'Store');
			if (go !== 'Store') return null;
		}
		const profile = await accounts.profileOf(token);
		const login = accounts.loginAccount();
		const orgId = (profile && profile.orgId) || check.orgId || null;
		const entry = {
			tokenId: tokenFingerprint(token),
			orgId,
			email: profile && profile.email ? profile.email : null,
			plan: profile && profile.plan ? profile.plan : null,
			addedAt: Date.now(),
		};
		let replace = this.store.match(entry);
		if (!replace) {
			const same = this.store.sameOrg(entry);
			if (same) {
				const pick = await vscode.window.showQuickPick([
					{ label: `Renew the token of ${this._shown(same.id, same.name)}`, id: same.id },
					{ label: 'Add as a separate account', id: null },
				], { title: `This token belongs to the same organization as ${this._shown(same.id, same.name)}`, ignoreFocusOut: true });
				if (!pick) return null;
				replace = pick.id ? same : null;
			}
		}
		let name = entry.email || (replace && replace.name) || (login && orgId && orgId === login.orgId ? login.email : null);
		if (!name) {
			name = await vscode.window.showInputBox({
				title: 'Name this Claude account',
				prompt: 'Anthropic does not tell a setup-token its email address. How should the panel call this account?',
				value: `Claude account ${this.store.list().length + 2}`,
				// With names hidden, the name typed here stays off the screen too.
				password: this.namesHidden(),
				ignoreFocusOut: true,
			});
			if (!name || !name.trim()) name = `Claude account ${this.store.list().length + 2}`;
		}
		entry.name = name.trim();
		const before = replace ? replace.tokenId : null;
		let result;
		try {
			result = await this.store.put(entry, token, replace ? replace.id : null);
		} catch (err) {
			vscode.window.showErrorMessage(`Agent View could not store the token in VS Code's credential store (${err && err.message ? err.message : err}). It is still in the terminal.`);
			return null;
		}
		// A renewed account that Claude Code runs on gets its new token there too.
		const current = accounts.activeToken();
		if (before && current && tokenFingerprint(current) === before) {
			accounts.writeActiveToken(token);
			accounts.noteWritten(token);
		}
		this.fetched.delete(result.entry.id);
		this.log(`accounts: ${result.replaced ? 'renewed' : 'added'} ${result.entry.name}`);
		this.render();
		vscode.window.showInformationMessage(`${result.replaced ? 'Renewed the token of' : 'Added'} ${this._shown(result.entry.id, result.entry.name)}.${result.replaced ? '' : ' To run Claude Code on it, right-click it in the Accounts panel and choose Use This Account.'}`);
		return result.entry;
	}

	// One reminder per account, window and reset: the account in use is spent.
	// It offers an account that still has room, or says none has.
	async _limitNotice(snap) {
		const active = snap.rows.find((r) => r.active);
		if (!active || !active.usage || active.usage.error) return;
		const spent = accounts.spentWindow(active.usage.windows);
		if (!spent) return;
		const key = `${active.id}:${spent[0]}:${spent[1].resetsAt || 'x'}`;
		if (this.context.globalState.get(NOTIFIED_KEY) === key) return;
		await this.context.globalState.update(NOTIFIED_KEY, key);
		const free = snap.rows.find((r) => !r.active && !(r.usage && !r.usage.error && accounts.isExhausted(r.usage.windows)));
		const what = spent[0] === 'week' ? 'weekly' : spent[0];
		const spentName = this._shown(active.id, active.name);
		if (!free) {
			vscode.window.showWarningMessage(`${spentName} has reached its ${what} limit, and no other account in the Accounts list has room left.`);
			return;
		}
		const choice = await vscode.window.showWarningMessage(`${spentName} has reached its ${what} limit.`, `Use ${this._shown(free.id, free.name)}`);
		if (!choice) return;
		try { await this.use(free.id); } catch (err) {
			this.log(`accounts: switch from the limit notice failed: ${err && err.stack ? err.stack : err}`);
			vscode.window.showErrorMessage(`Agent View: ${err && err.message ? err.message : err}`);
		}
	}
}

// The first candidate Anthropic accepts, else the first one it did not refuse
// outright (rate limit, outage): { token, check }. With no usable candidate:
// { token: null, why }. count_tokens runs first because it is free. It did not
// accept a fresh setup-token on 2026-11-23, so a candidate it turns down gets
// the Claude Code check, and only that check may refuse a token.
async function pickToken(candidates, { exe, log, signal } = {}) {
	if (!candidates.length) return { token: null, why: 'no sk-ant-oat01- token in the text' };
	const doubted = [];
	for (const c of candidates.slice(0, 4)) {
		if (signal && signal.aborted) return { token: null, why: 'cancelled' };
		const check = await accounts.checkToken(c);
		if (check.ok) return { token: c, check };
		doubted.push({ token: c, check });
	}
	let maybe = null;
	let why = '';
	for (const d of doubted.slice(0, 3)) {
		if (signal && signal.aborted) return { token: null, why: 'cancelled' };
		const cli = await accounts.checkTokenWithClaude(d.token, exe || claudeExecutable(), { signal });
		if (log) log(`accounts: token check, ${d.token.length} chars: count_tokens ${d.check.status || d.check.error}, Claude Code ${cli.ok ? 'ok' : cli.status || cli.error}`);
		if (cli.ok) return { token: d.token, check: { ...d.check, ok: true, status: 200 } };
		if (!why) why = cli.status ? `HTTP ${cli.status}${cli.error ? `: ${cli.error}` : ''}` : cli.error || 'no answer';
		if (!maybe && !AUTH_REFUSED(cli.status)) maybe = { token: d.token, check: { ok: false, status: cli.status, error: cli.error } };
	}
	return maybe || { token: null, why };
}

// The shape of a name without its text: letters and digits become x, so the
// blurred row keeps the length, the @ and the dots of an email address.
function maskName(name) {
	return String(name).replace(/[\p{L}\p{N}]/gu, 'x');
}

// The command line for the user's default shell. VS Code's executeCommand
// (executable, args) quotes only the arguments, so a path with a space
// ("C:\Users\Max Mustermann\...") has to be quoted here.
function setupTokenCommand(exe, shell) {
	const name = path.basename(String(shell || '')).toLowerCase();
	if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return `& '${exe.replace(/'/g, "''")}' setup-token`;
	if (/^cmd(\.exe)?$/.test(name)) return `"${exe}" setup-token`;
	if (!name && process.platform === 'win32') return `& '${exe.replace(/'/g, "''")}' setup-token`;
	return `'${exe.replace(/'/g, "'\\''")}' setup-token`;
}

function waitForShellIntegration(terminal, ms) {
	if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
	if (typeof vscode.window.onDidChangeTerminalShellIntegration !== 'function') return Promise.resolve(null);
	return new Promise((resolve) => {
		const timer = setTimeout(() => { sub.dispose(); resolve(null); }, ms);
		const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
			if (e.terminal !== terminal) return;
			clearTimeout(timer);
			sub.dispose();
			resolve(e.shellIntegration);
		});
	});
}

// The Claude Code build the chats run: the one inside the Claude Code
// extension. A plain `claude` on PATH when that extension is missing.
function claudeExecutable() {
	const ext = vscode.extensions.getExtension('anthropic.claude-code');
	if (ext) {
		for (const name of process.platform === 'win32' ? ['claude.exe'] : ['claude', 'claude.exe']) {
			const file = path.join(ext.extensionPath, 'resources', 'native-binary', name);
			if (fs.existsSync(file)) return file;
		}
	}
	return 'claude';
}

module.exports = { AccountsViewProvider, AccountStore, setupTokenCommand, pickToken, maskName, NAMES_HIDDEN_CONTEXT };
