// Keeps the "deepseek" subagent option in Claude Code's binary across Claude
// Code updates; tools/patch-claude.cjs does the edit. On activation, and only
// while the model router is on, a binary that lost the patch gets one offer
// per Claude Code version. Two commands check and re-apply on demand.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TOOL = path.join(__dirname, 'tools', 'patch-claude.cjs');
// { file, size, mtimeMs, state } of the last checked binary: an unchanged
// binary is not read again.
const SEEN_KEY = 'openEditorsTools.claudePatch.seen';
// Claude Code version whose offer was answered with "Not for this version".
const DECLINED_KEY = 'openEditorsTools.claudePatch.declined';

function claudeBinary() {
	const ext = vscode.extensions.getExtension('anthropic.claude-code');
	if (!ext) return null;
	const dir = path.join(ext.extensionPath, 'resources', 'native-binary');
	for (const name of process.platform === 'win32' ? ['claude.exe'] : ['claude', 'claude.exe']) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return { file, version: (ext.packageJSON && ext.packageJSON.version) || '?' };
	}
	return null;
}

// The extension host's process.execPath is VS Code's own executable;
// ELECTRON_RUN_AS_NODE makes it run the tool as plain Node. The tool reads
// the whole binary, so it runs in a child process, never on this thread.
function runTool(args) {
	return new Promise((resolve) => {
		execFile(process.execPath, [TOOL, ...args, '--json'], {
			timeout: 120000, windowsHide: true, maxBuffer: 1 << 20,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		}, (err, stdout) => {
			let results = null;
			try { results = JSON.parse(String(stdout || '')); } catch (_) { /* reported below */ }
			resolve(Array.isArray(results) && results[0] ? results[0] : { state: 'failed', detail: err ? err.message : 'no output' });
		});
	});
}

function register(context, log, { delayMs = 5000 } = {}) {
	const routerOn = () => vscode.workspace.getConfiguration('openEditorsTools').get('modelRouter.enabled', false);

	const check = async (bin) => {
		let stat;
		try { stat = fs.statSync(bin.file); } catch (_) { return { state: 'failed', detail: 'binary missing' }; }
		const seen = context.globalState.get(SEEN_KEY);
		if (seen && seen.file === bin.file && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) return seen;
		const r = await runTool(['--binary', bin.file]);
		if (['patched', 'needs-fix', 'unsupported'].includes(r.state)) {
			await context.globalState.update(SEEN_KEY, { file: bin.file, size: stat.size, mtimeMs: stat.mtimeMs, state: r.state });
		}
		return r;
	};

	const apply = async (bin) => {
		const r = await runTool(['--binary', bin.file, '--fix']);
		await context.globalState.update(SEEN_KEY, undefined);
		log(`claude patch: ${bin.version} -> ${r.state}${r.detail ? ` (${r.detail})` : ''}`);
		if (r.state === 'fixed' || r.state === 'patched') {
			vscode.window.showInformationMessage(`Claude Code ${bin.version}: "deepseek" subagents are on. Chats opened from now on can use them; open chats keep the old binary until reopened.`);
		} else {
			vscode.window.showWarningMessage(`Claude Code ${bin.version}: patch not applied (${r.state}${r.detail ? `: ${r.detail}` : ''}).`);
		}
		return r;
	};

	const offer = async () => {
		if (!routerOn()) return;
		const bin = claudeBinary();
		if (!bin) return;
		const r = await check(bin);
		if (r.state !== 'needs-fix' || context.globalState.get(DECLINED_KEY) === bin.version) return;
		const pick = await vscode.window.showInformationMessage(
			`Claude Code ${bin.version} replaced its binary, so "deepseek" subagents are off. Re-apply the Agent View patch? Subagent models then are deepseek, opus and haiku (sonnet and fable drop out of that list).`,
			'Re-apply', 'Not for this version');
		if (pick === 'Re-apply') await apply(bin);
		else if (pick === 'Not for this version') await context.globalState.update(DECLINED_KEY, bin.version);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('openEditorsTools.checkClaudePatch', async () => {
			const bin = claudeBinary();
			if (!bin) return vscode.window.showWarningMessage('Claude Code extension not found.');
			await context.globalState.update(SEEN_KEY, undefined);
			const r = await check(bin);
			const text = {
				patched: 'patched, "deepseek" subagents available',
				'needs-fix': 'not patched. Run "Agent View: Claude Code: Re-apply DeepSeek Subagent Patch".',
				unsupported: 'unknown binary layout, this version cannot be patched',
			}[r.state] || `check failed (${r.detail || r.state})`;
			vscode.window.showInformationMessage(`Claude Code ${bin.version}: ${text}`);
		}),
		vscode.commands.registerCommand('openEditorsTools.reapplyClaudePatch', async () => {
			const bin = claudeBinary();
			if (!bin) return vscode.window.showWarningMessage('Claude Code extension not found.');
			await context.globalState.update(DECLINED_KEY, undefined);
			await apply(bin);
		}),
	);

	// Off the activation path; the check spawns a process that reads ~230 MB.
	const timer = setTimeout(() => {
		offer().catch((err) => log(`claude patch: check failed (${err && err.message ? err.message : err})`));
	}, delayMs);
	context.subscriptions.push({ dispose: () => clearTimeout(timer) });
	return { offer };
}

module.exports = { register, _internal: { claudeBinary, runTool, TOOL } };
