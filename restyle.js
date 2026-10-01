const fs = require('fs');
const os = require('os');
const path = require('path');

// Restyles Claude Code's chat panel by appending an override block to the
// stylesheet the extension ships (webview/index.css): roomier bullets, tool
// cards and thinking rows hidden, and only a turn's last message visible —
// the quiet timeline Codex ships by default.
//
// Class names in that stylesheet are hashed per build, so the two hashes this
// needs are read out of the stylesheet at apply time. An extension update
// installs a fresh directory; reapplying on activation (see extension wiring)
// keeps the look without the user noticing the update happened.

const MARKER_PREFIX = '/* agent-view-restyle';
const MARKER = '/* agent-view-restyle v1 */';

function stylesheets() {
	const roots = [
		path.join(os.homedir(), '.vscode', 'extensions'),
		path.join(os.homedir(), '.vscode-insiders', 'extensions'),
		path.join(os.homedir(), '.vscode-server', 'extensions'),
	];
	const hits = [];
	for (const root of roots) {
		let names;
		try { names = fs.readdirSync(root); } catch (_) { continue; }
		for (const name of names) {
			if (!name.startsWith('anthropic.claude-code-')) continue;
			const css = path.join(root, name, 'webview', 'index.css');
			try { hits.push({ css, mtime: fs.statSync(css).mtimeMs }); } catch (_) { /* no webview build */ }
		}
	}
	// Newest build per root — VS Code keeps old versions on disk beside it.
	hits.sort((a, b) => b.mtime - a.mtime);
	const seen = new Set();
	return hits.filter((h) => {
		const root = h.css.split(path.sep).slice(0, -4).join(path.sep);
		if (seen.has(root)) return false;
		seen.add(root);
		return true;
	}).map((h) => h.css);
}

function apply() {
	const results = [];
	for (const cssFile of stylesheets()) {
		let css;
		try { css = fs.readFileSync(cssFile, 'utf8'); } catch (err) { results.push({ cssFile, status: `unreadable: ${err.message}` }); continue; }
		if (css.includes(MARKER)) { results.push({ cssFile, status: 'already applied' }); continue; }
		const old = css.indexOf(MARKER_PREFIX);
		if (old !== -1) css = css.slice(0, old).trimEnd() + '\n';

		// The markdown root: the class whose paragraph rule is unmistakable.
		const m = css.match(/\.(root_[-\w]+) p\{white-space:pre-wrap/);
		// The tool card shares its CSS-module hash with .toolSummary_<hash>.
		const t = css.match(/\.toolSummary_([-\w]+)\{/);
		if (!m || !t) { results.push({ cssFile, status: 'bundle shape changed — skipped' }); continue; }
		const root = m[1];
		const toolRoot = `root_${t[1]}`;

		try { fs.copyFileSync(cssFile, cssFile + '.agent-view-restyle.bak'); } catch (_) { /* best effort */ }
		const block = `
${MARKER}
.${root} :is(p,li){line-height:1.6}
.${root} p{margin-top:.35em;margin-bottom:.55em}
.${root} li{margin:.4em 0}
.${root} li>p{margin:.15em 0}
.${root} :is(ul,ol){padding-inline-start:1.5em;margin-block:.35em}
.${root} li::marker{color:var(--app-secondary-foreground)}
[class*="turn_"] [class*="timelineMessage_"]:has(~ [class*="timelineMessage_"]:not(:has(.${toolRoot}, [class*="thinking_"]))){display:none}
[class*="timelineMessage_"]:has(.${toolRoot}){display:none}
[class*="timelineMessage_"]:has([class*="thinking_"]){display:none}
.${toolRoot}{display:none}
[class*="toolBodyWrapper_"]{display:none}
`;
		try {
			fs.writeFileSync(cssFile, css.trimEnd() + '\n' + block);
			results.push({ cssFile, status: 'applied' });
		} catch (err) {
			results.push({ cssFile, status: `write failed: ${err.message}` });
		}
	}
	return results;
}

function revert() {
	const results = [];
	for (const cssFile of stylesheets()) {
		let css;
		try { css = fs.readFileSync(cssFile, 'utf8'); } catch (_) { continue; }
		const at = css.indexOf(MARKER_PREFIX);
		if (at === -1) { results.push({ cssFile, status: 'not applied' }); continue; }
		try {
			fs.writeFileSync(cssFile, css.slice(0, at).trimEnd() + '\n');
			results.push({ cssFile, status: 'reverted' });
		} catch (err) {
			results.push({ cssFile, status: `write failed: ${err.message}` });
		}
	}
	return results;
}

module.exports = { apply, revert, MARKER };
