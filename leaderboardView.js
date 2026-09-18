const crypto = require('crypto');

class LeaderboardViewProvider {
	constructor(cache, log) {
		this.cache = cache;
		this.log = log || (() => {});
		this.view = null;
		// Set by register(): returns { css, html } for the Usage bars while the
		// Usage view is collapsed or hidden, else null. VS Code gives every pane
		// a 120 px minimum body, which left dead space under the five bars; in
		// here they take exactly the height they need.
		this.usageBlock = null;
	}

	resolveWebviewView(webviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: false };
		this.log('leaderboard view resolved');
		webviewView.onDidChangeVisibility(() => {
			this.log(`leaderboard view visibility: ${webviewView.visible}`);
			if (webviewView.visible) this.render();
		});
		this.render();
	}

	async render() {
		if (!this.view) return;
		let snapshot;
		try {
			snapshot = this.cache.getSnapshot();
			snapshot.hasKey = await this.cache.hasKey();
			this.view.webview.html = this._html(snapshot);
		} catch (err) {
			this.log(`leaderboard render failed: ${err && err.stack ? err.stack : err}`);
			this.view.webview.html = errorHtml(err);
		}
	}

	_html(snapshot) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src 'nonce-${nonce}';`;
		const columns = [
			this._column('Reasoning', snapshot.reasoning),
			this._column('Coding', snapshot.coding),
		].join('\n');
		const notice = noticeLine(snapshot);
		let usage = null;
		try { usage = this.usageBlock ? this.usageBlock() : null; } catch (_) { usage = null; }

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	body {
		padding: 6px 8px 8px;
		margin: 0;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
	}
	.notice {
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
		line-height: 1.35;
		margin-bottom: 8px;
	}
	.notice.error { color: var(--vscode-errorForeground); }
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 6px;
	}
	.col {
		min-width: 0;
		border: 1px solid var(--vscode-widget-border);
		background: color-mix(in srgb, var(--vscode-editorWidget-background) 75%, transparent);
		border-radius: 6px;
		overflow: hidden;
	}
	.col-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 6px;
		padding: 5px 6px;
		border-bottom: 1px solid var(--vscode-widget-border);
	}
	.col-title { font-weight: 650; }
	.col-time {
		color: var(--vscode-descriptionForeground);
		font-size: 0.86em;
		white-space: nowrap;
	}
	.row {
		display: grid;
		grid-template-columns: 1.9em minmax(0, 1fr) max-content;
		align-items: center;
		gap: 4px;
		min-height: 20px;
		padding: 3px 6px;
		border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent);
	}
	.row:last-child { border-bottom: 0; }
	/* The rank colour names the provider, the same pair the Usage bars use:
	   foreground white for OpenAI, the Claude orange for Anthropic. It replaced
	   a provider line under every model, which cost a text row per entry. */
	.rank {
		color: var(--vscode-descriptionForeground);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.rank.openai { color: var(--vscode-foreground); }
	.rank.anthropic { color: #D97757; }
	.model { min-width: 0; }
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.score {
		text-align: right;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		color: var(--vscode-testing-iconPassed);
	}
	.empty {
		padding: 10px 8px;
		color: var(--vscode-descriptionForeground);
		line-height: 1.35;
	}
	@media (max-width: 280px) {
		.grid { grid-template-columns: minmax(0, 1fr); }
	}
	.usage { margin: 2px 4px 10px; }
${usage ? usage.css : ''}
</style>
</head>
<body>
${usage ? usage.html : ''}
${notice}
<div class="grid">
${columns}
</div>
</body>
</html>`;
	}

	_column(title, data) {
		if (!data) {
			return `<section class="col"><div class="col-head"><span class="col-title">${escapeHtml(title)}</span></div><div class="empty">No cached data yet.</div></section>`;
		}
		const rows = Array.isArray(data.rows) && data.rows.length
			? data.rows.map(rowHtml).join('\n')
			: '<div class="empty">No OpenAI or Anthropic models in this response.</div>';
		return `<section class="col">
	<div class="col-head"><span class="col-title">${escapeHtml(title)}</span><span class="col-time">${escapeHtml(shortTime(data.generatedAt))}</span></div>
${rows}
</section>`;
	}
}

function rowHtml(row) {
	return `<div class="row" title="${escapeHtml(`${row.name} · ${providerLabel(row.provider)}`)}">
	<div class="rank ${escapeHtml(row.provider)}">#${escapeHtml(row.rank)}</div>
	<div class="model">
		<div class="name">${escapeHtml(shortName(row))}</div>
	</div>
	<div class="score">${row.score === null ? '-' : escapeHtml(formatScore(row.score))}</div>
</div>`;
}

// The orange rank already says Anthropic, so the "claude-" prefix only costs
// the width that decides whether "fable-5-1" fits or ends in an ellipsis. The
// row tooltip keeps the full name.
function shortName(row) {
	const name = String(row.name || '');
	return row.provider === 'anthropic' ? name.replace(/^claude-/i, '') : name;
}

function stateLine(snapshot) {
	if (snapshot.inFlight) return 'Refreshing now. Calls are spaced for the free 1/min limit.';
	const last = snapshot.lastSuccessAt ? `Updated ${relativeTime(snapshot.lastSuccessAt)}` : 'Not refreshed yet';
	const next = snapshot.nextRefreshAt ? `next ${timeOnly(snapshot.nextRefreshAt)}` : '';
	return [last, next, 'local schedule 08/11/14/17/20'].filter(Boolean).join(' · ');
}

function noticeLine(snapshot) {
	if (!snapshot.hasKey) return '<div class="notice error">No API key set. Run “Agent View: Set AI Stupid Level API Key”.</div>';
	if (snapshot.lastError) return `<div class="notice error">${escapeHtml(snapshot.lastError)}</div>`;
	return '';
}

// Everything that used to sit above the table — source, schedule, freshness,
// quota — now answers the view's info button, so the panel itself is the two
// columns and nothing else.
function infoLines(snapshot) {
	const quota = snapshot.reasoning && snapshot.reasoning.quota && snapshot.reasoning.quota.remaining;
	return [
		'Source: AI Stupid Level (aistupidlevel.info), OpenAI and Anthropic models only.',
		'Rank colour: white = OpenAI, orange = Anthropic. Hover a row for the full model name.',
		stateLine(snapshot),
		'Each refresh costs 2 API calls, spaced for the free 1/min limit.',
		quota ? `API calls remaining after the last reasoning fetch: ${quota}` : null,
		snapshot.lastError ? `Last error: ${snapshot.lastError}` : null,
	].filter(Boolean);
}

function formatScore(score) {
	return Number.isInteger(score) ? String(score) : Number(score).toFixed(1);
}

function providerLabel(provider) {
	if (provider === 'openai') return 'OpenAI';
	if (provider === 'anthropic') return 'Anthropic';
	return provider || '';
}

function shortTime(value) {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return timeOnly(value);
}

function timeOnly(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relativeTime(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'recently';
	const mins = Math.round((Date.now() - date.getTime()) / 60000);
	if (mins <= 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function errorHtml(err) {
	const message = escapeHtml(String(err && err.message ? err.message : err));
	return `<!DOCTYPE html><html><body style="font:12px var(--vscode-font-family);color:var(--vscode-errorForeground);padding:8px">Leaderboard could not be drawn: ${message}</body></html>`;
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { LeaderboardViewProvider, infoLines, _internal: { stateLine, noticeLine, rowHtml, infoLines } };
