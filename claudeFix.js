const fs = require('fs');
const os = require('os');
const path = require('path');

// Patches Claude Code's host bundle (extension.js) to guard two call sites
// where the SDK's Query class has no renameSession method. Without this,
// every rename throws "TypeError: X.query.renameSession is not a function"
// and the webview never receives rename_session_response, so the tab falls
// back to the auto title.
//
// Claude Code auto-updates install a NEW version directory each time,
// reintroducing the bug. apply() runs at activation (see chatsView.js
// register()) and re-patches any fresh install the same way restyle.js
// handles the panel CSS.

const MARKER = '/* agent-view-fix rename-v1 */';

// The two broken patterns, exactly as they appear in 2.1.272/2.1.273
// builds. Single-letter names are minified and stable within a build; the
// structure (method call on query, .catch chained, withChannel callback)
// is what identifies the sites.
const PATTERN_CATCH = 'X.query.renameSession(Q,$).catch(J)';
const PATTERN_CALLBACK = '(W)=>W.query.renameSession(Q,$)';

// Guarded replacements: a typeof check prevents the throw when the SDK
// class lacks the method, and logs a clear message instead of crashing.
const REPLACEMENT_CATCH =
	'(typeof X.query.renameSession==="function"?X.query.renameSession(Q,$):Promise.reject(new Error("renameSession missing in this SDK build"))).catch(J)';
const REPLACEMENT_CALLBACK =
	'(W)=>{if(typeof W.query.renameSession!=="function")return void 0;return W.query.renameSession(Q,$)}';

function extensionRoots(overrideRoots) {
	if (overrideRoots) return overrideRoots;
	return [
		path.join(os.homedir(), '.vscode', 'extensions'),
		path.join(os.homedir(), '.vscode-insiders', 'extensions'),
		path.join(os.homedir(), '.vscode-server', 'extensions'),
	];
}

// Every anthropic.claude-code-*/extension.js under each root.
function bundleFiles(roots) {
	const hits = [];
	for (const root of roots) {
		let names;
		try { names = fs.readdirSync(root); } catch (_) { continue; }
		for (const name of names) {
			if (!name.startsWith('anthropic.claude-code-')) continue;
			const file = path.join(root, name, 'extension.js');
			try {
				fs.statSync(file);
				hits.push(file);
			} catch (_) { /* no bundle in this version dir */ }
		}
	}
	return hits;
}

function apply(options) {
	const roots = extensionRoots(options && options.roots);
	const results = [];
	for (const file of bundleFiles(roots)) {
		try {
			// Read as latin-1 so every byte round-trips without re-encoding.
			// The bundle contains only ASCII, but extension directories on
			// some systems carry non-UTF-8 bytes in paths or comments; latin-1
			// preserves them byte-for-byte.
			let content = fs.readFileSync(file, 'latin1');

			if (content.indexOf(MARKER) !== -1) {
				results.push({ file, action: 'already' });
				continue;
			}

			const hasCatch = content.indexOf(PATTERN_CATCH) !== -1;
			const hasCallback = content.indexOf(PATTERN_CALLBACK) !== -1;

			if (!hasCatch || !hasCallback) {
				// Upstream fixed the bug or renamed internals.
				results.push({ file, action: 'clean' });
				continue;
			}

			// Back up only once per install directory.
			const backup = file.replace(/extension\.js$/, 'extension.js.agent-view-orig');
			try {
				if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
			} catch (_) { /* best effort */ }

			content = content.split(PATTERN_CATCH).join(REPLACEMENT_CATCH);
			content = content.split(PATTERN_CALLBACK).join(REPLACEMENT_CALLBACK);
			content += '\n' + MARKER + '\n';

			fs.writeFileSync(file, content, 'latin1');
			results.push({ file, action: 'patched' });
		} catch (err) {
			results.push({ file, action: 'error', error: err.message });
		}
	}
	return results;
}

function revert(options) {
	const roots = extensionRoots(options && options.roots);
	const results = [];
	for (const file of bundleFiles(roots)) {
		const backup = file.replace(/extension\.js$/, 'extension.js.agent-view-orig');
		try {
			if (!fs.existsSync(backup)) {
				results.push({ file, action: 'no-backup' });
				continue;
			}
			fs.copyFileSync(backup, file);
			fs.unlinkSync(backup);
			results.push({ file, action: 'reverted' });
		} catch (err) {
			results.push({ file, action: 'error', error: err.message });
		}
	}
	return results;
}

module.exports = { apply, revert, MARKER };
