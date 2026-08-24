const vscode = require('vscode');
const crypto = require('crypto');
const { formatReset } = require('./usage');

// The usage rows as a webview rather than tree rows, because a TreeItem's
// description is plain theme-coloured text — there is no way to paint a bar in
// a product's own colour. Fills are each product's CI, taken from the logo
// files this extension already ships, so nothing new is invented:
//   Claude  #D97757  (the fill in resources/claude.svg)
//   Codex   white    (resources/codex.svg ships white; it only needs a darker
//                     value on light themes, where white would vanish)
const CLAUDE_FILL = '#D97757';
const CODEX_FILL_DARK = '#FFFFFF';
const CODEX_FILL_LIGHT = '#8E8E8E';

class UsageViewProvider {
	constructor(usage, log) {
		this.usage = usage;
		this.view = null;
		// Injected by register(). A blank panel used to be indistinguishable
		// from a panel that never got asked to draw, which is a bad place to
		// debug from — every step now says what it did.
		this.log = log || (() => {});
	}

	resolveWebviewView(webviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this.log('usage view resolved');
		// A view can be resolved while hidden and again when shown; both paths
		// have to paint, or the panel keeps whatever emptiness it started with.
		webviewView.onDidChangeVisibility(() => {
			this.log(`usage view visibility: ${webviewView.visible}`);
			if (webviewView.visible) this.render();
		});
		this.render();
	}

	render() {
		if (!this.view) { this.log('render skipped: view not resolved yet'); return; }
		let claude = null;
		let codex = null;
		try {
			claude = this.usage.get('claude');
			codex = this.usage.get('codex');
			this.view.webview.html = this._html(claude, codex);
			this.log(`rendered claude=${describe(claude)} codex=${describe(codex)}`);
		} catch (err) {
			// Whatever went wrong, say so in the panel. An empty webview reads
			// as "this feature is broken" and carries no way to find out why.
			this.log(`render failed: ${err && err.stack ? err.stack : err}`);
			try {
				this.view.webview.html = `<!DOCTYPE html><html><body style="font:12px var(--vscode-font-family);color:var(--vscode-errorForeground);padding:8px">`
					+ `Usage could not be drawn: ${escapeHtml(String(err && err.message ? err.message : err))}`
					+ `</body></html>`;
			} catch (_) { /* the view went away mid-render */ }
		}
	}

	_html(claude, codex) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src 'nonce-${nonce}';`;

		// Bar widths ride in generated classes rather than style="width:N%",
		// because a CSP nonce covers <style> elements but NOT inline style
		// attributes — those need 'unsafe-inline'. With the attribute silently
		// dropped, every bar renders full width and reads as 100% used.
		const widths = new Set();
		const rows = [
			this._row('Claude', 'claude', claude, widths),
			this._row('Codex', 'codex', codex, widths),
		].join('\n');
		const widthRules = [...widths].map((w) => `.w${w} { width: ${w}%; }`).join('\n\t');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	/* VS Code injects padding: 0 20px on body from inside @layer vscode-default,
	   so an unlayered rule wins regardless of specificity. */
	body {
		padding: 10px 12px;
		margin: 0;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
	}
	.row + .row { margin-top: 10px; }
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 3px;
	}
	.name { font-weight: 600; }
	/* One line per window: which window, how full, how much, when it resets.
	   Stacked bars with a single shared caption underneath read as one number
	   and left you guessing which bar was the 5-hour one. */
	.win {
		display: grid;
		grid-template-columns: 3.6em 1fr 2.6em 2.4em;
		align-items: center;
		column-gap: 6px;
		line-height: 1.7;
	}
	.win .label { color: var(--vscode-descriptionForeground); }
	.win .pct { text-align: right; font-variant-numeric: tabular-nums; }
	.win .reset {
		text-align: right;
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
	.sub {
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
	}
	/* Spans, not divs, so they sit in the grid row — which means they need an
	   explicit display or they collapse to inline height. */
	.track {
		display: block;
		height: 6px;
		border-radius: 3px;
		background: var(--vscode-input-background);
		overflow: hidden;
	}
	.fill { display: block; height: 100%; border-radius: 3px; }
	.claude .fill { background: ${CLAUDE_FILL}; }
	.codex .fill { background: ${CODEX_FILL_DARK}; }
	/* White disappears on a light theme; fall back to the logo's own grey. */
	body.vscode-light .codex .fill { background: ${CODEX_FILL_LIGHT}; }
	.muted { color: var(--vscode-descriptionForeground); }
	${widthRules}
</style>
</head>
<body>
${rows}
</body>
</html>`;
	}

	_row(name, cls, usage, widths) {
		if (!usage) return `<div class="row ${cls}"><div class="head"><span class="name">${name}</span><span class="muted">checking…</span></div></div>`;
		if (usage.error) return `<div class="row ${cls}"><div class="head"><span class="name">${name}</span></div><div class="sub">${escapeHtml(usage.error)}</div></div>`;
		if (!usage.windows.length) return `<div class="row ${cls}"><div class="head"><span class="name">${name}</span><span class="muted">no limits reported</span></div></div>`;

		const lines = usage.windows
			.map(([label, w]) => {
				const pct = clamp(w.pct);
				widths.add(pct);
				const reset = w.resetsAt ? formatReset(w.resetsAt) : '';
				// title= gives a native tooltip, which spells out what the
				// right-hand column means without spending a line on it.
				return `<div class="win" title="${escapeHtml(label)} window · ${pct}% used${reset ? ` · resets in ${escapeHtml(reset)}` : ''}">
		<span class="label">${escapeHtml(label)}</span>
		<span class="track"><span class="fill w${pct}"></span></span>
		<span class="pct">${pct}%</span>
		<span class="reset">${escapeHtml(reset)}</span>
	</div>`;
			})
			.join('\n');

		return `<div class="row ${cls}">
	<div class="head"><span class="name">${name}</span><span class="sub">${escapeHtml(usage.plan || '')}</span></div>
${lines}
</div>`;
	}
}

function clamp(pct) {
	return Math.max(0, Math.min(100, Number(pct) || 0));
}

function describe(usage) {
	if (!usage) return 'pending';
	if (usage.error) return `error(${usage.error})`;
	return `${usage.windows.length} window(s)`;
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { UsageViewProvider };
