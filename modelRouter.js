// VS Code side of the model router (router.js): settings, the OpenRouter key,
// the provider policy, the cost log, Claude Code's model menu, and the
// environment entries in Claude Code's own claudeCode.environmentVariables
// setting. That setting reaches only the Claude processes the Claude Code
// extension launches, so a `claude` started in a terminal keeps talking to
// Anthropic directly.
//
// The environment entries exist only while a router answers: they are written
// once this window's router owns the port or another window's router does,
// and removed when the feature is switched off or the window shuts down. A
// crashed or uninstalled Agent View therefore leaves plain Claude behind,
// never a Claude Code that points at a dead port.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ModelRouter, DEFAULT_PORT } = require('./router');
const ranking = require('./providerRanking');

const SECRET_KEY = 'openEditorsTools.openRouterKey';
const WROTE_KEY = 'openEditorsTools.modelRouter.wroteEnv';
// One secret for every window and every VS Code profile of this user (profiles
// have separate globalState but share the router's port).
const SECRET_FILE = path.join(os.homedir(), '.agent-view', 'router-secret');
// Another way of reaching Claude: a gateway, Bedrock, Vertex or Foundry. When
// one of these is set anywhere Claude Code reads it, the router stays out.
const GATEWAY_VARS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const QUALIFY_RETRY_MS = 3600e3;
const SAFE_MODEL_KEY = 'openEditorsTools.modelRouter.lastSafeDefaultModel';
const LEDGER = path.join(os.homedir(), '.agent-view', 'router-usage.jsonl');
const PICKER_MARK = 'via Agent View';

// Providers headquartered in mainland China, Hong Kong or Singapore, or tied
// to Chinese groups (OpenRouter's provider list, checked 2026-10-01). The
// ranking already drops them by headquarters; this list also binds
// OpenRouter's own fallbacks.
const DEFAULT_IGNORED_PROVIDERS = ['deepseek', 'tencent', 'baidu', 'nex-agi', 'xiaomi', 'streamlake', 'alibaba',
	'moonshotai', 'minimax', 'z-ai', 'siliconflow', 'seed', 'stepfun', 'novita', 'phala'];
// v4.1-flash reads images (orchestrator chats); 0731 is the cheaper text-only
// flash that bare "deepseek" subagents run. Both listed, so the default-model
// guard also catches a 0731 pick.
const DEFAULT_PICKER_MODELS = ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-0731'];

function readRegistryEnv(name) {
	if (process.platform !== 'win32') return Promise.resolve('');
	return new Promise((resolve) => {
		execFile('reg', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true }, (err, stdout) => {
			if (err) return resolve('');
			const m = String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`));
			resolve(m ? m[1] : '');
		});
	});
}

function config() {
	return vscode.workspace.getConfiguration('openEditorsTools');
}

function routerPort() {
	const p = config().get('modelRouter.port', DEFAULT_PORT);
	return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
}

function readSecret() {
	try {
		const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
		return /^[0-9a-f]{64}$/.test(s) ? s : null;
	} catch (_) { return null; }
}

function routerSecret() {
	const existing = readSecret();
	if (existing) return existing;
	const fresh = crypto.randomBytes(32).toString('hex');
	try {
		fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
		// 'wx': of two windows starting at once, the first file wins and the
		// second reads it back.
		fs.writeFileSync(SECRET_FILE, fresh, { flag: fs.existsSync(SECRET_FILE) ? 'w' : 'wx', mode: 0o600 });
		return fresh;
	} catch (_) {
		return readSecret() || fresh;
	}
}

function ignoredProviders() {
	const list = config().get('modelRouter.ignoredProviders', DEFAULT_IGNORED_PROVIDERS);
	return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : DEFAULT_IGNORED_PROVIDERS;
}

// provider object for one OpenRouter request. Qualified providers only, in
// cost order, so a chat stays on one provider and its cache stays warm. With
// no qualified provider the request is refused: OpenRouter's own choice would
// be bound by the ignore list alone, which misses providers whose
// headquarters OpenRouter does not list.
async function routerPolicy(model, rankingImpl = ranking) {
	const ignore = ignoredProviders();
	const zdr = config().get('modelRouter.requireZeroDataRetention', true);
	const policy = { data_collection: 'deny', ignore, allow_fallbacks: true };
	if (zdr) policy.zdr = true;
	const rank = await rankingImpl.rankingFor(model, { ignore, requireZdr: zdr });
	// ignoredProviders strings are matched how the user wrote them: the base
	// slug, a spelled-out base with a provider tag, any case, or part of a
	// longer id. One shared predicate keeps the pin in provider.only/order and
	// the local filter consistent.
	const ignoresSlug = (slug) => {
		const base = slug.split('/')[0].toLowerCase();
		return ignore.some((i) => {
			const token = String(i).trim().toLowerCase();
			// A token matches at a slug separator, so a short token like "seed"
			// cannot drop an unrelated "see", "seeder" or "sea" provider.
			const bounds = (s, p) => s.length === p.length || s[p.length] === '/' || s[p.length] === '-';
			return token && (token === base || bounds(base, token.length) && base.startsWith(token) || bounds(token, base.length) && token.startsWith(base) || bounds(slug.toLowerCase(), token.length) && slug.toLowerCase().startsWith(token));
		});
	};
	const ranked = (rank.ranked || []).filter((slug) => !ignoresSlug(slug));
	if (!ranked.length) {
		throw new Error(`no qualified provider for ${model} yet. Run "Agent View: Model Router: Re-check OpenRouter Providers"`);
	}
	policy.only = ranked;
	policy.order = ranked;
	return policy;
}

function claudeSettingsPath() {
	return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

// Windows editors save settings.json with a BOM at times; JSON.parse refuses it.
function readSettingsJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// Where a gateway other than this router is configured, or null. Checked:
// VS Code's own environment (inherited by every claude it starts), the env
// block of Claude Code's user settings (applied after the launch environment),
// and claudeCode.environmentVariables.
function foreignGateway(ourBase, extEntries = [], env = process.env) {
	const set = (name, value) => value && !/^(0|false)$/i.test(String(value)) && !(name === 'ANTHROPIC_BASE_URL' && value === ourBase);
	for (const name of GATEWAY_VARS) if (set(name, env[name])) return `${name} in the VS Code environment`;
	let settingsEnv = {};
	try { settingsEnv = (readSettingsJson(claudeSettingsPath()) || {}).env || {}; } catch (_) { settingsEnv = {}; }
	for (const name of GATEWAY_VARS) if (set(name, settingsEnv[name])) return `${name} in ${claudeSettingsPath()}`;
	for (const e of extEntries) if (e && e.name !== 'ANTHROPIC_BASE_URL' && GATEWAY_VARS.includes(e.name) && set(e.name, e.value)) return `${e.name} in claudeCode.environmentVariables`;
	return null;
}

// Claude Code shows modelPicker rows from the user settings file in its model
// menu. Rows written here carry PICKER_MARK in their description, so a later
// sync replaces exactly those and leaves the user's own rows alone.
function syncPickerRows(rows, log) {
	const file = claudeSettingsPath();
	let settings = {};
	let text = null;
	try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (_) { text = null; }
	if (text !== null) {
		try { settings = JSON.parse(text); } catch (err) {
			log(`model router: ${file} is not plain JSON, model menu left unchanged (${err.message})`);
			return false;
		}
	}
	const picker = settings.modelPicker && typeof settings.modelPicker === 'object' ? settings.modelPicker : {};
	const others = (Array.isArray(picker.options) ? picker.options : [])
		.filter((o) => !(o && typeof o.description === 'string' && o.description.includes(PICKER_MARK)));
	const options = others.concat(rows);
	const before = JSON.stringify(settings.modelPicker || null);
	if (options.length) settings.modelPicker = { ...picker, options };
	else if (settings.modelPicker) {
		const { options: _drop, ...rest } = picker;
		if (Object.keys(rest).length) settings.modelPicker = rest; else delete settings.modelPicker;
	}
	if (JSON.stringify(settings.modelPicker || null) === before) return false;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	log(`model router: Claude Code model menu ${rows.length ? `lists ${rows.map((r) => r.model).join(', ')}` : 'no longer lists OpenRouter models'}`);
	return true;
}

// A menu row per model. "[1m]" tells Claude Code the model holds a
// 1M-token context; OpenRouter receives the bare id.
async function pickerRowFor(model, fetchImpl = globalThis.fetch) {
	let label = model.split('/').pop();
	let context = 0;
	try {
		const res = await fetchImpl(`https://openrouter.ai/api/v1/models/${model}/endpoints`, { signal: AbortSignal.timeout(5000) });
		const body = await res.json();
		if (body && body.data) {
			if (body.data.name) label = String(body.data.name).replace(/^[^:]+:\s*/, '');
			context = Math.max(0, ...((body.data.endpoints || []).map((e) => Number(e.context_length) || 0)));
		}
	} catch (_) { /* offline: plain row */ }
	return {
		model: context >= 1000000 ? `${model}[1m]` : model,
		label,
		description: `OpenRouter, zero data retention, ${PICKER_MARK}`,
	};
}

function appendLedger(entry) {
	try {
		fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
		fs.appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), id: entry.id, model: entry.model, provider: entry.provider, cost: entry.cost })}\n`);
	} catch (_) { /* cost display falls back to list prices */ }
}

function register(context, log, version) {
	let router = null;
	let syncing = Promise.resolve();
	// Set by shutdown(): a settings change still in flight must not write
	// environment entries or menu rows after the window removed them.
	let closed = false;
	const qualifying = new Set();
	const lastQualify = new Map();


	const getKey = async () => {
		const stored = await context.secrets.get(SECRET_KEY);
		if (stored) return stored;
		if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
		// VS Code started before the key was stored does not see it in its
		// environment; the registry has it.
		return readRegistryEnv('OPENROUTER_API_KEY');
	};

	// Re-check a model's providers in the background when the ranking is
	// stale or only the shipped seed. One run at a time per model, at most one
	// start per hour, so an offline or failing check does not repeat on every
	// request.
	const maybeQualify = async (model) => {
		if (qualifying.has(model) || !router || router.role !== 'owner') return;
		if (Date.now() - (lastQualify.get(model) || 0) < QUALIFY_RETRY_MS) return;
		const requireZdr = config().get('modelRouter.requireZeroDataRetention', true);
		const rank = await ranking.rankingFor(model, { ignore: ignoredProviders(), requireZdr });
		if (rank.fresh) return;
		const key = await getKey();
		if (!key || qualifying.has(model)) return;
		qualifying.add(model);
		lastQualify.set(model, Date.now());
		log(`model router: checking ${model} providers (${requireZdr ? 'zero data retention, ' : ''}reasoning kept out of answers, cache)`);
		ranking.qualify(model, key, { ignore: ignoredProviders(), requireZdr, log })
			.then((r) => log(`model router: ${model} order ${r.ranked.join(' > ') || '(none qualified)'}${Object.keys(r.unprobed || {}).length ? `; unprobed ${Object.keys(r.unprobed).join(', ')}` : ''}; check cost $${(r.spent || 0).toFixed(4)}`))
			.catch((err) => log(`model router: provider check for ${model} failed (${err && err.message ? err.message : err})`))
			.finally(() => qualifying.delete(model));
	};

	// Claude Code's model menu writes a pick into ~/.claude/settings.json as
	// the global default at times, and every chat on "Default" then follows
	// it — chats nobody switched suddenly run DeepSeek. While the guard is on,
	// a routed id landing in "model" is put back to the last non-routed value
	// (or removed when there was none), and the window says so once.
	let guardBusy = false;
	const guardDefaultModel = async () => {
		if (!config().get('modelRouter.enabled', false) || guardBusy) return;
		const file = claudeSettingsPath();
		let settings;
		try { settings = readSettingsJson(file); } catch (_) { return; }
		const current = typeof settings.model === 'string' ? settings.model : null;
		const models = config().get('modelRouter.pickerModels', DEFAULT_PICKER_MODELS);
		const routed = current && Array.isArray(models) && models.includes(current.replace(/\[1m\]$/i, ''));
		if (!routed) {
			// Remember what a sane default looks like, including "no line" —
			// also while the guard itself is off, so switching it on later
			// restores a current value, never one from before the off period.
			await context.globalState.update(SAFE_MODEL_KEY, current === null ? '' : current);
			return;
		}
		if (!config().get('modelRouter.defaultModelGuard', true)) return;
		guardBusy = true;
		try {
			const safe = context.globalState.get(SAFE_MODEL_KEY);
			if (safe) settings.model = safe; else delete settings.model;
			fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
			log(`model router: default model guard put ${file} back to ${safe || '(no default)'} after a menu pick set ${current}`);
			vscode.window.showInformationMessage(`${current} was about to become the default model for ALL Claude Code chats. Agent View put the default back to ${safe || 'Claude Code\u2019s own'}; the chat you picked it in keeps its model. Switch off openEditorsTools.modelRouter.defaultModelGuard to allow it.`);
		} catch (_) { /* read-only settings: leave it */ }
		guardBusy = false;
	};
	let settingsWatcher = null;
	const watchDefaultModel = (enabled) => {
		if (!enabled || settingsWatcher) {
			if (!enabled && settingsWatcher) { try { settingsWatcher.close(); } catch (_) { /* gone */ } settingsWatcher = null; }
			return;
		}
		try {
			let timer = null;
			settingsWatcher = fs.watch(claudeSettingsPath(), (eventType) => {
				clearTimeout(timer);
				timer = setTimeout(() => { guardDefaultModel().catch(() => {}); }, 400);
				if (eventType === 'rename') {
					// An atomic save replaced the file; this watch follows the
					// old inode on mac and linux and would go silent.
					try { settingsWatcher.close(); } catch (_) { /* gone */ }
					settingsWatcher = null;
					setTimeout(() => { if (!closed) watchDefaultModel(true); }, 1000);
				}
			});
		} catch (_) { settingsWatcher = null; /* file missing: created on first picker sync */ }
	};

	const policyFor = async (model) => {
		maybeQualify(model);
		return routerPolicy(model);
	};

	const baseUrl = (port) => `http://127.0.0.1:${port}`;

	// Add or remove our entries. ENABLE_TOOL_SEARCH keeps Claude Code's tool
	// search on behind a non-Anthropic base URL; without it every Claude chat
	// would send its full tool list each turn. A value someone else wrote
	// (another gateway) is never touched.
	// An entry is ours when its value is the one this extension recorded
	// writing, or (for the base URL only) points at the router's own port. A
	// user's own ENABLE_TOOL_SEARCH survives switching the router off.
	let foreignWhere = null;
	const syncEnv = async (wanted, port) => {
		const desired = { ANTHROPIC_BASE_URL: baseUrl(port), ENABLE_TOOL_SEARCH: 'true' };
		const claude = vscode.workspace.getConfiguration('claudeCode');
		const inspected = claude.inspect('environmentVariables');
		const current = Array.isArray(inspected && inspected.globalValue) ? inspected.globalValue : [];
		const wrote = context.globalState.get(WROTE_KEY) || {};
		const byName = new Map(current.filter((e) => e && e.name).map((e) => [e.name, e]));
		const base = byName.get('ANTHROPIC_BASE_URL');
		foreignWhere = null;
		if (base && base.value !== desired.ANTHROPIC_BASE_URL && base.value !== wrote.ANTHROPIC_BASE_URL) foreignWhere = 'claudeCode.environmentVariables';
		else foreignWhere = foreignGateway(desired.ANTHROPIC_BASE_URL, current);
		const foreign = wanted && !!foreignWhere;
		if (foreign) wanted = false;
		let next = current.slice();
		const nextWrote = { ...wrote };
		for (const [name, value] of Object.entries(desired)) {
			const entry = byName.get(name);
			const ours = !entry || entry.value === wrote[name] || (name === 'ANTHROPIC_BASE_URL' && entry.value === value);
			if (!ours) continue;
			next = next.filter((e) => !(e && e.name === name));
			if (wanted) { next.push({ name, value }); nextWrote[name] = value; } else delete nextWrote[name];
		}
		if (JSON.stringify(next) === JSON.stringify(current)) return foreign ? 'foreign' : wanted ? 'present' : 'absent';
		await claude.update('environmentVariables', next.length ? next : undefined, vscode.ConfigurationTarget.Global);
		await context.globalState.update(WROTE_KEY, nextWrote);
		log(`model router: Claude Code environment ${wanted ? `points at ${desired.ANTHROPIC_BASE_URL}` : 'back to Anthropic direct'} for newly started chats`);
		return foreign ? 'foreign' : wanted ? 'written' : 'removed';
	};

	// Rows are fetched once per settings change; an environment change (another
	// window closing) puts the cached rows back without a network call.
	let pickerRows = null;
	const syncPicker = async (enabled, refetch = true) => {
		try {
			if (!enabled) return syncPickerRows([], log);
			if (!pickerRows || refetch) {
				const models = config().get('modelRouter.pickerModels', DEFAULT_PICKER_MODELS);
				pickerRows = await Promise.all((Array.isArray(models) ? models : []).filter((m) => typeof m === 'string' && m.includes('/')).map((m) => pickerRowFor(m)));
			}
			if (closed) return false;
			return syncPickerRows(pickerRows, log);
		} catch (err) {
			log(`model router: model menu update failed (${err && err.message ? err.message : err})`);
			return false;
		}
	};

	const apply = (reason) => {
		syncing = syncing.then(async () => {
			if (closed) return;
			const enabled = config().get('modelRouter.enabled', false);
			const port = routerPort();
			if (router && (!enabled || router.port !== port)) {
				await router.stop();
				router = null;
			}
			if (!enabled) {
				watchDefaultModel(false);
				await syncEnv(false, port);
				// 'startup' too: a crashed window leaves rows that otherwise
				// stay in the menu until the next settings change.
				if (reason === 'setting' || reason === 'startup') await syncPicker(false);
				return;
			}
			if (!router) {
				router = new ModelRouter({ port, getKey, getPolicy: policyFor, log, version, onUsage: appendLedger,
					getModelInfo: (model) => ranking.modelInfo(model),
					secret: routerSecret(),
					onReject: (model, slug, why) => { ranking.demote(model, slug, why); log(`model router: ${slug} dropped for ${model}: ${why}`); },
					// The port came free (its owner window closed, or another
					// program let go of it): write the entries again.
					onRoleChange: () => apply('role') });
			}
			router.serverToolModel = config().get('modelRouter.serverToolModel', 'claude-sonnet-5');
			router.secret = routerSecret();
			await router.start();
			if (closed || !router) return;
			const serving = router.role === 'owner' || router.role === 'standby';
			const result = await syncEnv(serving, port);
			const inUse = serving && result !== 'foreign';
			const quiet = reason === 'env' || reason === 'role';
			await syncPicker(inUse, !quiet);
			await guardDefaultModel();
			watchDefaultModel(inUse);
			if (!serving && !quiet) {
				vscode.window.showWarningMessage(`Agent View model router could not start: ${router.lastError || router.role}. Claude Code keeps talking to Anthropic directly.`);
			} else if (result === 'foreign' && !quiet) {
				vscode.window.showWarningMessage(`${foreignWhere === 'claudeCode.environmentVariables' ? 'claudeCode.environmentVariables already sets ANTHROPIC_BASE_URL to another gateway' : `Claude Code already uses another gateway (${foreignWhere})`}. Agent View left it alone, so the model router is not in use.`);
			}
		}).catch((err) => log(`model router: ${err && err.message ? err.message : err}`));
		return syncing;
	};

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('openEditorsTools.modelRouter')) apply('setting');
			// Another window removed the entries while closing; this window
			// takes over the port and puts them back.
			else if (e.affectsConfiguration('claudeCode.environmentVariables') && config().get('modelRouter.enabled', false)) apply('env');
		}),
		vscode.commands.registerCommand('openEditorsTools.setOpenRouterKey', async () => {
			const key = await vscode.window.showInputBox({
				title: 'OpenRouter API key',
				prompt: 'Stored in VS Code SecretStorage. It is never written to settings or git.',
				password: true,
				ignoreFocusOut: true,
				validateInput: (v) => (!v || /sk-or-[A-Za-z0-9_-]{20,}/.test(v) ? null : 'An OpenRouter key starts with sk-or-'),
			});
			if (!key) return;
			const match = key.match(/sk-or-[A-Za-z0-9_-]{20,}/);
			await context.secrets.store(SECRET_KEY, match ? match[0] : key.trim());
			vscode.window.showInformationMessage('OpenRouter key saved.');
		}),
		vscode.commands.registerCommand('openEditorsTools.clearOpenRouterKey', async () => {
			await context.secrets.delete(SECRET_KEY);
			vscode.window.showInformationMessage('OpenRouter key removed from VS Code. An OPENROUTER_API_KEY environment variable is still used if present.');
		}),
		vscode.commands.registerCommand('openEditorsTools.toggleModelRouter', async () => {
			const on = !config().get('modelRouter.enabled', false);
			await config().update('modelRouter.enabled', on, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(on
				? 'Model router on. Chats opened from now on list OpenRouter models in the model menu (/model). Chats already open keep their connection until reopened.'
				: 'Model router off. Chats opened from now on talk to Anthropic directly.');
		}),
		vscode.commands.registerCommand('openEditorsTools.requalifyProviders', async () => {
			const key = await getKey();
			if (!key) return vscode.window.showWarningMessage('No OpenRouter key. Run "Agent View: Set OpenRouter API Key" first.');
			const models = config().get('modelRouter.pickerModels', DEFAULT_PICKER_MODELS);
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking OpenRouter providers' }, async () => {
				const lines = [];
				const requireZdr = config().get('modelRouter.requireZeroDataRetention', true);
				for (const model of models) {
					try {
						const r = await ranking.qualify(model, key, { ignore: ignoredProviders(), requireZdr, log });
						lines.push(`${model}: ${r.ranked.join(' > ') || '(none qualified)'} ($${(r.spent || 0).toFixed(4)})`);
					} catch (err) { lines.push(`${model}: failed (${err.message})`); }
				}
				vscode.window.showInformationMessage('Provider order', { modal: true, detail: lines.join('\n') });
			});
		}),
		vscode.commands.registerCommand('openEditorsTools.modelRouterStatus', async () => {
			const enabled = config().get('modelRouter.enabled', false);
			const key = await getKey();
			const s = router ? router.status() : { role: 'stopped', port: routerPort(), last: [] };
			const models = config().get('modelRouter.pickerModels', DEFAULT_PICKER_MODELS);
			const orders = await Promise.all(models.map(async (m) => {
				const r = await ranking.rankingFor(m, { ignore: ignoredProviders(), requireZdr: config().get('modelRouter.requireZeroDataRetention', true) });
				return `${m}: ${r.ranked.slice(0, 4).join(' > ') || 'none qualified, requests refused'} (${r.source}${r.at ? `, ${r.at.slice(0, 10)}` : ''})`;
			}));
			const lines = [
				`Enabled: ${enabled ? 'yes' : 'no'}`,
				`Router: ${s.role} on 127.0.0.1:${s.port}${s.lastError ? ` (${s.lastError})` : ''}`,
				`OpenRouter key: ${key ? `found (${key.length} chars)` : 'missing'}`,
				`Zero data retention: ${config().get('modelRouter.requireZeroDataRetention', true) ? 'required' : 'not required'}`,
				...orders,
				`Requests this window: ${s.anthropic || 0} Anthropic, ${s.openrouter || 0} OpenRouter, ${s.errors || 0} errors`,
				...s.last.slice(-5).map((r) => `${r.at.slice(11, 19)} ${r.model} ${r.status} ${r.provider || '?'}${r.cost != null ? ` $${r.cost.toFixed(5)}` : ''}`),
			];
			vscode.window.showInformationMessage('Model router', { modal: true, detail: lines.join('\n') });
		}),
		{ dispose: () => { if (router) router.stop(); } },
	);

	apply('startup');

	// Called from deactivate(): drop the environment entries so a closed or
	// uninstalled Agent View never leaves Claude Code pointing at a dead port.
	// Another open window puts them back through its configuration listener.
	return {
		// Ordered for a short shutdown window: the local menu file first, then
		// the router (milliseconds), then the environment entry.
		async shutdown() {
			closed = true;
			watchDefaultModel(false);
			if (!router) return;
			// A standby window leaves the menu rows to the window that serves;
			// that window may sit in another VS Code profile, which hears no
			// settings event from this one and would not put them back.
			if (router.role !== 'standby') {
				try { syncPickerRows([], log); } catch (_) { /* window closing */ }
			}
			await Promise.race([syncing.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
			const port = router ? router.port : routerPort();
			// The port is freed before the entry goes, so a waiting window that
			// hears the change binds it at once instead of on its next retry.
			if (router) await router.stop();
			router = null;
			try { await syncEnv(false, port); } catch (_) { /* window closing */ }
		},
		getRouter: () => router,
	};
}

module.exports = {
	register,
	routerPolicy,
	DEFAULT_IGNORED_PROVIDERS,
	DEFAULT_PICKER_MODELS,
	_internal: { readRegistryEnv, syncPickerRows, pickerRowFor, claudeSettingsPath, readSettingsJson, appendLedger, foreignGateway, routerSecret, routerPort, LEDGER, PICKER_MARK, SECRET_FILE, SAFE_MODEL_KEY },
};
