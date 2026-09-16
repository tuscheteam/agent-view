const crypto = require('crypto');

class LeaderboardViewProvider {
	constructor(cache, log) {
		this.cache = cache;
		this.log = log || (() => {});
		this.view = null;
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
		const state = stateLine(snapshot);
		const notice = noticeLine(snapshot);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	body {
		padding: 10px 12px 12px;
		margin: 0;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}
	.title {
		font-weight: 650;
		letter-spacing: 0;
	}
	.pill {
		border: 1px solid var(--vscode-widget-border);
		border-radius: 999px;
		padding: 1px 6px;
		color: var(--vscode-descriptionForeground);
		font-size: 0.86em;
		white-space: nowrap;
	}
	.meta, .notice {
		color: var(--vscode-descriptionForeground);
		font-size: 0.9em;
		line-height: 1.35;
		margin-bottom: 8px;
	}
	.notice.error { color: var(--vscode-errorForeground); }
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 10px;
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
		padding: 7px 8px;
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
		grid-template-columns: 2.2em minmax(0, 1fr) 2.5em;
		align-items: center;
		gap: 6px;
		min-height: 34px;
		padding: 5px 8px;
		border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent);
	}
	.row:last-child { border-bottom: 0; }
	.rank {
		color: var(--vscode-descriptionForeground);
		font-variant-numeric: tabular-nums;
	}
	.model { min-width: 0; }
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.provider {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--vscode-descriptionForeground);
		font-size: 0.86em;
		margin-top: 1px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--vscode-descriptionForeground);
		flex: 0 0 auto;
	}
	.dot.openai { background: var(--vscode-foreground); }
	.dot.anthropic { background: #D97757; }
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
</style>
</head>
<body>
<div class="top">
	<div class="title">AI Stupid Level</div>
	<div class="pill">2 calls / refresh</div>
</div>
<div class="meta">${state}</div>
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
	<div class="rank">#${escapeHtml(row.rank)}</div>
	<div class="model">
		<div class="name">${escapeHtml(row.name)}</div>
		<div class="provider"><span class="dot ${escapeHtml(row.provider)}"></span>${escapeHtml(providerLabel(row.provider))}</div>
	</div>
	<div class="score">${row.score === null ? '-' : escapeHtml(formatScore(row.score))}</div>
</div>`;
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
	const quota = snapshot.reasoning && snapshot.reasoning.quota && snapshot.reasoning.quota.remaining
		? `API remaining after reasoning: ${snapshot.reasoning.quota.remaining}`
		: 'Source: aistupidlevel.info';
	return `<div class="notice">${escapeHtml(quota)}</div>`;
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

module.exports = { LeaderboardViewProvider, _internal: { stateLine, noticeLine, rowHtml } };
