#!/usr/bin/env node
// Adds "deepseek" to the model list Claude Code's Agent tool accepts, inside
// Claude Code's own native binary. Agent View's router maps a bare "deepseek"
// subagent to an OpenRouter DeepSeek model. Every Claude Code update ships a
// fresh binary and drops the patch, so this runs again after each update
// (Agent View offers it on activation while the model router is on).
//
//   node patch-claude.cjs                  status of every installed Claude Code
//   node patch-claude.cjs --fix            patch them
//   node patch-claude.cjs --undo           put the original literal back
//   node patch-claude.cjs --binary <file>  act on one binary only
//   node patch-claude.cjs --json           one JSON array on stdout
//
// The edit is a same-length swap of one string literal. The binary carries the
// literal three times (the model-family list, the Agent tool's model enum, the
// Bedrock/Vertex tier list); only the copy followed by the Agent tool's
// ".optional().describe(`Optional model override" is swapped. A build without
// exactly one such copy is refused. Because the swap is exact, --undo writes
// the literal back and needs no backup. The patched file is written next to
// the binary and renamed into place, so running chats keep the old file
// until they exit (Windows: the old file is renamed aside, swept later). On
// macOS the new file gets an ad-hoc signature before it goes live. The swap
// removes "sonnet" and "fable" from the Agent tool's model choices. Patching
// Anthropic's file is a workaround that Anthropic support does not cover.
//
// Exit code: 0 = every binary patched, 1 = a binary needs the patch or a write
// failed, 2 = a binary has an unknown layout (left untouched).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OLD = Buffer.from('["sonnet","opus","haiku","fable"]', 'latin1');
// Same length as OLD (33 bytes). Keeps opus and haiku, drops the sonnet and
// fable family aliases; versioned Claude ids are not part of this list.
const NEW = Buffer.from('["deepseek","opus","haiku"      ]', 'latin1');
const ANCHOR_A = Buffer.from(').optional().describe(', 'latin1');
const ANCHOR_B = Buffer.from('Optional model override', 'latin1');
const OLD_COPY = '.agentview-old-';
const NEW_COPY = '.agentview-new-';
const BIN_NAMES = process.platform === 'win32' ? ['claude.exe'] : ['claude', 'claude.exe'];

function extensionRoots() {
	const home = os.homedir();
	return ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-server-insiders']
		.map((d) => path.join(home, d, 'extensions'));
}

function installedBinaries() {
	const out = [];
	for (const root of extensionRoots()) {
		let names;
		try { names = fs.readdirSync(root); } catch (_) { continue; }
		for (const name of names) {
			const m = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(name);
			if (!m) continue;
			for (const bin of BIN_NAMES) {
				const file = path.join(root, name, 'resources', 'native-binary', bin);
				if (fs.existsSync(file)) { out.push({ version: m[1], file }); break; }
			}
		}
	}
	return out;
}

// Is the literal at `at` the Agent tool's model enum? Its schema follows the
// literal directly: ).optional().describe(<quote>Optional model override...
function isAgentEnum(buf, at) {
	const p = at + OLD.length;
	return buf.subarray(p, p + ANCHOR_A.length).equals(ANCHOR_A)
		&& buf.subarray(p + ANCHOR_A.length + 1, p + ANCHOR_A.length + 1 + ANCHOR_B.length).equals(ANCHOR_B);
}

// Every copy of the literal, original or swapped.
function sites(buf) {
	const out = [];
	for (const [needle, swapped] of [[OLD, false], [NEW, true]]) {
		for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) out.push({ at, swapped, target: isAgentEnum(buf, at) });
	}
	return out;
}

// patched: the Agent tool's copy is swapped and nothing else is.
// needs-fix: the Agent tool's copy is original, or another copy is swapped
// (versions of this tool before 0.14.9 swapped every copy).
function stateOf(buf) {
	const all = sites(buf);
	const targets = all.filter((x) => x.target);
	if (targets.length !== 1) return { state: 'unsupported', copies: targets.length };
	const strays = all.filter((x) => x.swapped && !x.target).length;
	if (targets[0].swapped && !strays) return { state: 'patched' };
	return strays ? { state: 'needs-fix', strays } : { state: 'needs-fix' };
}

// The patched bytes (enable) or the original bytes (disable).
function rewrite(buf, enable) {
	const out = Buffer.from(buf);
	for (const x of sites(buf)) (enable && x.target ? NEW : OLD).copy(out, x.at);
	return out;
}

// Remove renamed-away copies (deletable once the chats that ran them exited)
// and half-written new files from an interrupted run.
function sweepLeftovers(file) {
	const dir = path.dirname(file);
	const base = path.basename(file);
	let names = [];
	try { names = fs.readdirSync(dir); } catch (_) { return; }
	for (const name of names) {
		if (name.startsWith(base + OLD_COPY) || name.startsWith(base + NEW_COPY)) {
			try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* still running */ }
		}
	}
}

// Puts buf at file without writing into the running binary: the new bytes go
// to a file next to it, then take its name. POSIX rename swaps the directory
// entry and running processes keep the old inode. Windows cannot rename over a
// running exe, but can rename it aside; the aside copy is deleted at once when
// nothing runs it, else swept by a later run.
function replaceBinary(file, buf) {
	const dir = path.dirname(file);
	const base = path.basename(file);
	let mode = 0o755;
	try { mode = fs.statSync(file).mode; } catch (_) { /* default */ }
	const tmp = path.join(dir, `${base}${NEW_COPY}${process.pid}`);
	fs.writeFileSync(tmp, buf, { mode });
	try {
		// A modified Mach-O loses its signature and Apple silicon kills an
		// unsigned binary at launch; sign the new file before it goes live.
		if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--sign', '-', tmp], { stdio: 'ignore' });
		if (process.platform === 'win32') {
			const aside = path.join(dir, `${base}${OLD_COPY}${process.pid}-${Date.now()}`);
			fs.renameSync(file, aside);
			try { fs.renameSync(tmp, file); } catch (err) { fs.renameSync(aside, file); throw err; }
			try { fs.unlinkSync(aside); } catch (_) { /* in use until its chats exit */ }
		} else {
			fs.renameSync(tmp, file);
		}
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
		throw err;
	}
}

function patchOne(entry, mode) {
	const result = { version: entry.version, file: entry.file };
	sweepLeftovers(entry.file);
	let buf;
	try { buf = fs.readFileSync(entry.file); } catch (err) { return { ...result, state: 'failed', detail: err.message }; }
	const before = stateOf(buf);
	if (mode === 'status' || before.state === 'unsupported') return { ...result, ...before };
	if (mode === 'undo' && !sites(buf).some((x) => x.swapped)) return { ...result, state: 'restored', detail: 'already original' };
	if (mode === 'fix' && before.state === 'patched') return { ...result, ...before };
	try {
		replaceBinary(entry.file, rewrite(buf, mode === 'fix'));
		const after = fs.readFileSync(entry.file);
		if (mode === 'undo') {
			return sites(after).some((x) => x.swapped) ? { ...result, state: 'failed', detail: 'verify found swapped copies' } : { ...result, state: 'restored' };
		}
		const st = stateOf(after);
		if (st.state !== 'patched') return { ...result, state: 'failed', detail: `verify found ${st.state}` };
		return { ...result, state: 'fixed', ...(before.strays ? { detail: `repaired ${before.strays} copies an older version swapped` } : {}) };
	} catch (err) {
		return { ...result, state: 'failed', detail: err.message };
	}
}

function main(argv) {
	const mode = argv.includes('--undo') ? 'undo' : argv.includes('--fix') ? 'fix' : 'status';
	const asJson = argv.includes('--json');
	const bi = argv.indexOf('--binary');
	const entries = bi >= 0 && argv[bi + 1]
		? [{ version: path.basename(path.dirname(path.dirname(path.dirname(argv[bi + 1])))).replace(/^anthropic\.claude-code-/, '') || 'binary', file: argv[bi + 1] }]
		: installedBinaries();
	const results = entries.map((e) => patchOne(e, mode));
	if (asJson) {
		process.stdout.write(JSON.stringify(results));
	} else if (!results.length) {
		console.log('No Claude Code install found.');
	} else {
		for (const r of results) console.log(`[${r.version}] ${r.state}${r.detail ? ` - ${r.detail}` : ''}  ${r.file}`);
	}
	if (results.some((r) => r.state === 'unsupported')) return 2;
	if (!results.length || results.some((r) => r.state === 'needs-fix' || r.state === 'failed')) return 1;
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, stateOf, rewrite, OLD, NEW };
