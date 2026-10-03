// vscode:uninstall hook (package.json scripts). VS Code runs this with node
// after the extension is uninstalled, when no extension code will ever run
// again — deactivate() alone cannot clean up, because current VS Code builds
// tear down the configuration RPC before deactivation, so a settings write
// from there is lost. Without this hook an uninstalled Agent View could leave
// ANTHROPIC_BASE_URL pointing at a router that no longer exists, and every
// Claude Code panel chat would fail to connect.
//
// Removed, best effort and only where clearly ours:
// - ANTHROPIC_BASE_URL entries pointing at 127.0.0.1 (any port), plus the
//   ENABLE_TOOL_SEARCH entry that travels with them, from
//   claudeCode.environmentVariables in each VS Code variant's user settings;
// - model-menu rows marked "via Agent View" in ~/.claude/settings.json, and
//   the global default model when it is one of those rows (a user's own
//   vendor model stays);
// A settings file that does not parse as plain JSON (JSONC comments) is left
// untouched; the README's manual steps cover that case.
const fs = require('fs');
const os = require('os');
const path = require('path');

function userSettingsFiles() {
	const home = os.homedir();
	const roots = process.platform === 'win32'
		? [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')]
		: process.platform === 'darwin'
			? [path.join(home, 'Library', 'Application Support')]
			: [process.env.XDG_CONFIG_HOME || path.join(home, '.config')];
	const variants = ['Code', 'Code - Insiders', 'VSCodium', 'Code - OSS'];
	const files = [];
	for (const root of roots) for (const v of variants) files.push(path.join(root, v, 'User', 'settings.json'));
	return files;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function stripRouterEnv(file) {
	let settings;
	try { settings = readJson(file); } catch (_) { return false; }
	const key = 'claudeCode.environmentVariables';
	const list = settings[key];
	if (!Array.isArray(list)) return false;
	// Only the router's own port: a user-made 127.0.0.1 entry for another
	// local proxy (LiteLLM and the like) is not ours to delete.
	const raw = settings['openEditorsTools.modelRouter.port'];
	const port = Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : 47861;
	const ours = (e) => e && e.name === 'ANTHROPIC_BASE_URL' && String(e.value || '') === `http://127.0.0.1:${port}`;
	if (!list.some(ours)) return false;
	const next = list.filter((e) => !ours(e) && !(e && e.name === 'ENABLE_TOOL_SEARCH' && e.value === 'true'));
	if (next.length) settings[key] = next; else delete settings[key];
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}

function stripPickerRows() {
	const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
	let settings = {};
	try { settings = readJson(file); } catch (_) { return false; }
	let wrote = false;
	// Ids of Agent View's own rows, needed again below to decide whether the
	// global default model is one of them — after the rows are gone the marker
	// no longer exists to check.
	const ours = new Set();
	const picker = settings.modelPicker;
	if (picker && Array.isArray(picker.options)) {
		for (const o of picker.options) {
			if (o && typeof o.description === 'string' && o.description.includes('via Agent View')) {
				ours.add(String(o.model || '').replace(/\[1m\]$/i, ''));
			}
		}
		const keep = picker.options.filter((o) => !(o && typeof o.description === 'string' && o.description.includes('via Agent View')));
		if (keep.length !== picker.options.length) {
			if (keep.length) picker.options = keep;
			else {
				const { options: _drop, ...rest } = picker;
				if (Object.keys(rest).length) settings.modelPicker = rest; else delete settings.modelPicker;
			}
			wrote = true;
		}
	}
	// A menu pick the guard never saw may sit in the global default; after the
	// uninstall there is no guard. Remove only ids Agent View itself installs
	// rows for — a user's own vendor model stays.
	if (typeof settings.model === 'string' && ours.has(settings.model.replace(/\[1m\]$/i, ''))) {
		delete settings.model;
		wrote = true;
	}
	if (!wrote) return false;
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	return true;
}

try {
	for (const file of userSettingsFiles()) {
		try { if (stripRouterEnv(file)) console.log(`agent-view uninstall: removed router environment entries from ${file}`); } catch (_) { /* locked or read-only */ }
	}
	try { if (stripPickerRows()) console.log('agent-view uninstall: removed Agent View rows from the Claude Code model menu'); } catch (_) { /* locked or read-only */ }
	// Without the router a bare "deepseek" subagent has nowhere to go: give
	// Claude Code its original Agent tool model list back.
	try { require('./tools/patch-claude.cjs').main(['--undo']); } catch (_) { /* binary in use or gone */ }
} catch (_) { /* never fail the uninstall */ }
