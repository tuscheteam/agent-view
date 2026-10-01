// Model router: a small HTTP server on 127.0.0.1 that Claude Code reaches
// through ANTHROPIC_BASE_URL. Requests for Claude models pass through to
// api.anthropic.com untouched, so a Claude subscription login keeps working.
// Requests for OpenRouter models ("vendor/model", e.g.
// deepseek/deepseek-v4-flash-0731) go to OpenRouter's Anthropic-format
// endpoint with the user's OpenRouter key and a provider policy: zero data
// retention, no training, excluded providers, cheapest first.
// /model in a Claude Code chat therefore switches that one chat between
// Anthropic and OpenRouter.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const ROUTER_ID = 'agent-view-model-router';
const HEALTH_PATH = '/__agentview/router';
const DEFAULT_PORT = 47861;

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api';

// Request headers that belong to the Claude login or to Anthropic betas and
// must never reach OpenRouter.
const DROP_TO_OPENROUTER = new Set([
	'authorization', 'x-api-key', 'anthropic-beta', 'cookie', 'host', 'content-length',
	'connection', 'accept-encoding', 'proxy-authorization',
]);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

const COOL_MS = 5 * 60 * 1000;
// Provider prompt caches live minutes; ten covers a normal pause between turns.
const STICKY_MS = 10 * 60 * 1000;

// An OpenRouter model id always carries its vendor ("deepseek/..."); a Claude
// model id never does.
function routeFor(model) {
	return typeof model === 'string' && model.includes('/') ? 'openrouter' : 'anthropic';
}

// "[1m]" and similar picker suffixes describe the context window to Claude
// Code; OpenRouter only knows the bare id.
function bareModel(model) {
	return String(model).replace(/\[[^\]]*\]$/, '').trim();
}

// Thinking blocks carry a provider-bound signature. Anthropic rejects a block
// another provider produced (OpenRouter returns them with an empty
// signature), and OpenRouter models cannot use Claude's. Each side therefore
// gets only the thinking blocks it produced itself.
function filterThinking(messages, keep) {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((m) => {
		if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return m;
		const content = m.content.filter((b) => {
			if (!b || (b.type !== 'thinking' && b.type !== 'redacted_thinking')) return true;
			return keep(b);
		});
		if (content.length === m.content.length) return m;
		changed = true;
		// An assistant turn may not end up empty.
		return { ...m, content: content.length ? content : [{ type: 'text', text: '(thinking omitted)' }] };
	});
	return changed ? out : messages;
}
const anthropicSigned = (b) => b.type === 'redacted_thinking' || (typeof b.signature === 'string' && b.signature.length > 0);
const foreignSigned = (b) => !anthropicSigned(b);

// Body for Anthropic: untouched unless it carries thinking blocks another
// provider produced. Returns the original Buffer when nothing changed, so the
// bytes (and prompt caching) stay exactly as Claude Code sent them.
function anthropicBody(raw, json) {
	if (!json || !Array.isArray(json.messages)) return raw;
	const messages = filterThinking(json.messages, anthropicSigned);
	if (messages === json.messages) return raw;
	return Buffer.from(JSON.stringify({ ...json, messages }));
}

// Body for OpenRouter: the bare model id, the provider policy, and only what
// a non-Anthropic model can take. Fields are adjusted by transformForOpenRouter.
function openRouterBody(json, policy, sessionId, modelInfo = {}) {
	const body = transformForOpenRouter({ ...json, model: bareModel(json.model) }, modelInfo);
	body.provider = { ...policy };
	if (sessionId && !body.session_id) body.session_id = String(sessionId).slice(0, 256);
	return body;
}

const IMAGE_NOTE = '[image omitted: this model cannot read images. Switch the chat to a Claude model with /model to look at it.]';
const DOCUMENT_NOTE = '[document omitted: this model cannot read attached documents. Switch the chat to a Claude model with /model to read it.]';

// A text-only model makes OpenRouter answer 404 ("No endpoints found that
// support image input") for the whole request, and the image stays in the
// history, so every later turn would fail too. Images and PDFs become a short
// note instead, in user turns and inside tool results (a Read of a .png).
// modelInfo.images / modelInfo.documents keep what the model can read.
function replaceMedia(content, modelInfo = {}) {
	if (!Array.isArray(content)) return content;
	let changed = false;
	const out = content.map((b) => {
		if (!b || typeof b !== 'object') return b;
		if (b.type === 'image' && !modelInfo.images) { changed = true; return { type: 'text', text: IMAGE_NOTE }; }
		if (b.type === 'document' && !modelInfo.documents) { changed = true; return { type: 'text', text: DOCUMENT_NOTE }; }
		if (b.type === 'tool_result' && Array.isArray(b.content)) {
			const inner = replaceMedia(b.content, modelInfo);
			if (inner !== b.content) { changed = true; return { ...b, content: inner }; }
		}
		return b;
	});
	return changed ? out : content;
}

// Anthropic-only request features stripped before OpenRouter. Kept as one
// function so the list follows what Claude Code actually sends (captured from
// Claude Code 2.1.285).
function transformForOpenRouter(body, modelInfo = {}) {
	const out = { ...body };
	if (Array.isArray(out.messages)) out.messages = filterThinking(out.messages, foreignSigned);
	// Server tools (web search, code execution, advisor ...) run on Anthropic's
	// side only; a custom tool has no type or type "custom". Deferred loading
	// is Anthropic's tool search, which OpenRouter models cannot resolve, so
	// every remaining tool is sent in full.
	if (Array.isArray(out.tools)) {
		out.tools = out.tools
			.filter((t) => t && (!t.type || t.type === 'custom') && t.name !== 'DeferredToolPlaceholder')
			.map((t) => {
				const { defer_loading: _drop, ...rest } = t;
				if (rest.input_schema) rest.input_schema = stripPatterns(rest.input_schema);
				return rest;
			});
		if (!out.tools.length) { delete out.tools; delete out.tool_choice; }
	}
	if (Array.isArray(out.messages)) {
		out.messages = out.messages.flatMap((m) => {
			if (!m) return [m];
			// With tool search on, Claude Code announces tools through system
			// messages made of tool_addition / tool_removal blocks, a Claude-only
			// feature. The tools themselves are already in the list above.
			if (m.role === 'system' && Array.isArray(m.content)) {
				const content = m.content.filter((b) => b && b.type !== 'tool_addition' && b.type !== 'tool_removal');
				if (content.length !== m.content.length) return content.length ? [{ ...m, content }] : [];
				return [m];
			}
			if ((!modelInfo.images || !modelInfo.documents) && m.role === 'user') {
				const content = replaceMedia(m.content, modelInfo);
				return content === m.content ? [m] : [{ ...m, content }];
			}
			return [m];
		});
	}
	// The VS Code panel adds a classifier context for Anthropic's
	// dangerous-tool-use check; it means nothing to other providers.
	delete out.safeguards;
	delete out.context_management;
	delete out.container;
	delete out.mcp_servers;
	// metadata.user_id carries the Anthropic account and device ids; OpenRouter
	// gets the chat's session id as session_id instead.
	delete out.metadata;
	return out;
}

// Regex constraints in tool schemas ("pattern": "^...$") are compiled into
// some providers' grammar engines, and one unsupported regex rejects the whole
// request (Sail Research refused Claude Code's Artifact tool for it). Claude
// Code validates tool input itself, so the hint can go. A property that is
// merely NAMED "pattern" (Glob, Grep) holds an object and stays.
function stripPatterns(schema) {
	if (Array.isArray(schema)) return schema.map(stripPatterns);
	if (!schema || typeof schema !== 'object') return schema;
	const out = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === 'pattern' && typeof v === 'string') continue;
		out[k] = stripPatterns(v);
	}
	return out;
}

// Claude Code runs WebSearch as a separate request with the chat's model and
// Anthropic's web_search server tool, which only Anthropic can execute.
function isServerToolRequest(json) {
	return Array.isArray(json && json.tools) && json.tools.some((t) => t && typeof t.type === 'string' && /^web_search|^web_fetch|^code_execution/.test(t.type));
}

// The web-search sub-request of an OpenRouter chat, rewritten for a Claude
// model: a [1m] chat adds the long-context beta, which a short search request
// does not need and which some subscriptions reject, and Haiku takes no effort
// setting.
function serverToolRequest(json, headers, claudeModel) {
	const body = { ...json, model: claudeModel };
	if (/haiku/i.test(claudeModel) && body.output_config) {
		const { effort: _drop, ...rest } = body.output_config;
		if (Object.keys(rest).length) body.output_config = rest; else delete body.output_config;
	}
	const out = { ...headers };
	if (typeof out['anthropic-beta'] === 'string') {
		const betas = out['anthropic-beta'].split(',').map((s) => s.trim()).filter((s) => s && !/^context-1m/.test(s));
		if (betas.length) out['anthropic-beta'] = betas.join(','); else delete out['anthropic-beta'];
	}
	return { body, headers: out };
}

// Claude Code puts its session id into metadata.user_id; one id per chat keeps
// a chat on one provider, so that provider's prompt cache stays warm.
function sessionIdOf(json) {
	const raw = json && json.metadata && json.metadata.user_id;
	if (typeof raw !== 'string' || !raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.session_id === 'string') return parsed.session_id;
	} catch (_) { /* plain string */ }
	const m = /session_([0-9a-f-]{8,})/i.exec(raw);
	return m ? m[1] : raw.slice(0, 128);
}

function anthropicError(res, status, type, message) {
	const body = JSON.stringify({ type: 'error', error: { type, message } });
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
}

// A reply the upstream breaks off must reach Claude Code as a broken
// connection, which it retries at once; an orderly end would leave it waiting
// minutes for more data.
function relayBreaks(upRes, res) {
	const broken = () => { if (!upRes.complete && !res.destroyed) res.destroy(); };
	upRes.on('aborted', broken);
	upRes.on('error', broken);
	upRes.on('close', broken);
}

function forward(base, req, res, body, headers, onDone) {
	const target = new URL(base);
	const pathPrefix = target.pathname.replace(/\/$/, '');
	const lib = target.protocol === 'http:' ? http : https;
	const outHeaders = { ...headers, host: target.host };
	if (body) outHeaders['content-length'] = body.length;
	const upstream = lib.request({
		protocol: target.protocol,
		hostname: target.hostname,
		port: target.port || undefined,
		path: pathPrefix + req.url,
		method: req.method,
		headers: outHeaders,
	}, (upRes) => {
		const resHeaders = {};
		for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) resHeaders[k] = v;
		res.writeHead(upRes.statusCode || 502, resHeaders);
		relayBreaks(upRes, res);
		if (onDone) {
			const chunks = [];
			upRes.on('data', (c) => { chunks.push(c); res.write(c); });
			upRes.on('end', () => { res.end(); onDone(upRes.statusCode, Buffer.concat(chunks), upRes.headers); });
		} else {
			upRes.pipe(res);
		}
	});
	upstream.on('error', (err) => {
		if (!res.headersSent) anthropicError(res, 502, 'api_error', `Agent View model router: upstream ${target.host} unreachable (${err.code || err.message}).`);
		else if (!res.destroyed) res.destroy();
	});
	// Esc in Claude Code closes its socket. The upstream reply stops with it,
	// so it does not keep running against the user's limits.
	res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
	if (body && body.length) upstream.end(body); else upstream.end();
}

// Message and provider of an OpenRouter error reply. OpenRouter names the
// provider that failed in metadata.provider_name, at the top level or inside
// error, and passes the provider's own text as metadata.raw.
function errorInfo(buf) {
	const text = buf.toString('utf8');
	try {
		const j = JSON.parse(text);
		const e = j.error || {};
		const meta = { ...(j.metadata || {}), ...(e.metadata || {}) };
		const raw = meta.raw ? ` [${String(meta.raw).slice(0, 300)}]` : '';
		return { text: `${e.type || ''} ${e.message || ''}${raw}`.trim().slice(0, 500), provider: meta.provider_name || null };
	} catch (_) {
		return { text: text.slice(0, 300), provider: null };
	}
}
const errorText = (buf) => errorInfo(buf).text;

// The reply names its provider ("Sail Research"); the order holds slugs
// ("sail-research/us"). Matched without separators and case.
function slugForProvider(name, slugs) {
	if (!name || !Array.isArray(slugs)) return null;
	const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
	const n = norm(name);
	return slugs.find((x) => norm(x.split('/')[0]) === n) || slugs.find((x) => n.startsWith(norm(x.split('/')[0]))) || null;
}

// Cost, provider, cache reads and id of an OpenRouter reply, streamed or not.
// OpenRouter reports the USD cost in usage.cost (message_delta when streaming).
function usageOf(buf, headers) {
	const text = buf.toString('utf8');
	const info = { id: null, provider: null, cost: null, model: null, cacheRead: 0 };
	const take = (obj) => {
		if (!obj || typeof obj !== 'object') return;
		const msg = obj.message || obj;
		if (msg.id && !info.id) info.id = msg.id;
		if (msg.model && !info.model) info.model = msg.model;
		if (obj.provider) info.provider = obj.provider;
		if (msg.provider) info.provider = msg.provider;
		const usage = obj.usage || msg.usage;
		if (usage && typeof usage.cost === 'number') info.cost = usage.cost;
		if (usage && Number(usage.cache_read_input_tokens) > info.cacheRead) info.cacheRead = Number(usage.cache_read_input_tokens);
	};
	if (/^\s*\{/.test(text)) {
		try { take(JSON.parse(text)); } catch (_) { /* partial */ }
	} else {
		for (const line of text.split('\n')) {
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (!data || data === '[DONE]') continue;
			try { take(JSON.parse(data)); } catch (_) { /* not json */ }
		}
	}
	if (!info.id && headers && headers['x-generation-id']) info.id = headers['x-generation-id'];
	return info;
}

// Some providers number tool calls per reply ("call_0" every time). Claude
// Code keeps only the first block with a given id, drops the later ones as
// "[Tool use interrupted]", and the model then repeats the same call. Every
// tool_use id in an OpenRouter reply is therefore rewritten to one that is
// unique across the chat and valid for Anthropic when the chat switches back.
function toolIdFor(messageId, index) {
	const tail = String(messageId || crypto.randomBytes(6).toString('hex')).replace(/[^A-Za-z0-9_]/g, '').slice(-32);
	return `toolu_or_${tail}_${index}`;
}

function rewriteToolIdsInMessage(msg) {
	if (!msg || !Array.isArray(msg.content)) return false;
	let changed = false;
	msg.content.forEach((b, i) => {
		if (b && b.type === 'tool_use') { b.id = toolIdFor(msg.id, i); changed = true; }
	});
	return changed;
}

// Streamed replies are rewritten event by event; everything but a tool_use
// content_block_start passes through unchanged. The decoder holds back a
// character whose UTF-8 bytes are split across two network chunks.
class ToolIdRewriter {
	constructor() {
		this.buffer = '';
		this.messageId = null;
		this.decoder = new StringDecoder('utf8');
	}

	push(chunk) {
		this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
		let out = '';
		let idx;
		while ((idx = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
			const sep = this.buffer.slice(idx).match(/^\r?\n\r?\n/)[0];
			const event = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + sep.length);
			out += this._event(event) + sep;
		}
		return out;
	}

	flush() {
		const rest = this.buffer + this.decoder.end();
		this.buffer = '';
		return rest ? this._event(rest) : '';
	}

	_event(event) {
		if (!event.includes('message_start') && !event.includes('"tool_use"')) return event;
		const lines = event.split(/\r?\n/);
		const i = lines.findIndex((l) => l.startsWith('data:'));
		if (i === -1) return event;
		let obj;
		try { obj = JSON.parse(lines[i].slice(5).trim()); } catch (_) { return event; }
		if (obj && obj.type === 'message_start' && obj.message && obj.message.id) {
			this.messageId = obj.message.id;
			return event;
		}
		if (obj && obj.type === 'content_block_start' && obj.content_block && obj.content_block.type === 'tool_use') {
			obj.content_block.id = toolIdFor(this.messageId, obj.index);
			lines[i] = `data: ${JSON.stringify(obj)}`;
			return lines.join('\n');
		}
		return event;
	}
}

class ModelRouter {
	constructor(options = {}) {
		this.port = options.port || DEFAULT_PORT;
		this.getKey = options.getKey || (async () => null);
		this.getPolicy = options.getPolicy || (() => ({}));
		// { images, documents } for a model; text-only unless told otherwise.
		this.getModelInfo = options.getModelInfo || (async () => ({ images: false, documents: false }));
		this.log = options.log || (() => {});
		this.onUsage = options.onUsage || (() => {});
		// A provider rejected a request that another provider then served.
		this.onReject = options.onReject || (() => {});
		// Shared by every Agent View window of this user. A window trusts a
		// router on the port only when it proves it holds the same secret, so
		// another program squatting the port never receives Claude's login.
		this.secret = options.secret || null;
		this.cooling = new Map();
		this.sticky = new Map();
		// The Claude model that runs server tools (web search) for chats on an
		// OpenRouter model.
		this.serverToolModel = options.serverToolModel || 'claude-sonnet-5';
		this.anthropicBase = options.anthropicBase || ANTHROPIC_BASE;
		this.openRouterBase = options.openRouterBase || OPENROUTER_BASE;
		this.version = options.version || '0';
		this.retryMs = options.retryMs || 15000;
		this.server = null;
		this.role = 'stopped';
		this.retryTimer = null;
		// Bumped by stop(): a port check still running from before the stop
		// must not bring this router back.
		this.gen = 0;
		// Called when a background retry changes the role (standby or blocked
		// to owner), so the window can write its environment entries again.
		this.onRoleChange = options.onRoleChange || (() => {});
		this.stats = { anthropic: 0, openrouter: 0, errors: 0, last: [] };
	}

	// Several VS Code windows each run Agent View; the first one to bind the
	// port serves every window. The others stand by and take over when the
	// owner closes, so Claude Code always finds a router while any window runs.
	// Safe to call repeatedly: a standby router retries the port at once, which
	// is how a window takes over right after the owner window closed.
	async start() {
		if (this.role === 'owner') return this.role;
		clearTimeout(this.retryTimer);
		return this._tryListen();
	}

	_tryListen() {
		const gen = this.gen;
		return new Promise((resolve) => {
			const server = http.createServer((req, res) => this._handle(req, res));
			server.keepAliveTimeout = 65000;
			server.once('error', async (err) => {
				if (gen !== this.gen) return resolve(this.role);
				if (err.code !== 'EADDRINUSE') {
					this.role = 'error';
					this.lastError = err.message;
					this.log(`model router: cannot listen on ${this.port} (${err.message})`);
					return resolve(this.role);
				}
				const peer = await probe(this.port, { secret: this.secret });
				if (gen !== this.gen) return resolve(this.role);
				this.role = peer ? 'standby' : 'blocked';
				this.lastError = peer ? null : `port ${this.port} is used by another program`;
				this.log(peer ? `model router: standby, window pid ${peer.pid} serves port ${this.port}` : `model router: ${this.lastError}`);
				this._scheduleRetry();
				resolve(this.role);
			});
			server.listen(this.port, '127.0.0.1', () => {
				if (gen !== this.gen) { server.close(); return resolve(this.role); }
				this.server = server;
				this.role = 'owner';
				this.lastError = null;
				this.log(`model router: listening on 127.0.0.1:${this.port}`);
				resolve(this.role);
			});
		});
	}

	_scheduleRetry() {
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(async () => {
			if (this.role !== 'standby' && this.role !== 'blocked') return;
			const before = this.role;
			const role = await this._tryListen();
			if (role !== before) this.onRoleChange(role);
		}, this.retryMs);
		if (this.retryTimer.unref) this.retryTimer.unref();
	}

	async stop() {
		this.gen++;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
		const server = this.server;
		this.server = null;
		this.role = 'stopped';
		if (server) {
			if (server.closeAllConnections) server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve()));
		}
	}

	status() {
		return { role: this.role, port: this.port, lastError: this.lastError || null, ...this.stats, last: this.stats.last.slice(-10) };
	}

	_note(entry) {
		this.stats.last.push({ at: new Date().toISOString(), ...entry });
		if (this.stats.last.length > 50) this.stats.last.shift();
	}

	async _handle(req, res) {
		// Only local programs may use the router. A web page could otherwise
		// post to 127.0.0.1 and spend the user's OpenRouter credit: browsers
		// always send Origin on such requests, Claude Code never does, and a
		// foreign Host header means DNS rebinding.
		const host = String(req.headers.host || '').toLowerCase();
		if (req.headers.origin || req.method === 'OPTIONS' || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
			res.writeHead(403, { 'content-type': 'application/json' });
			return res.end('{"type":"error","error":{"type":"permission_error","message":"Agent View model router accepts local programs only."}}');
		}
		if (req.url === HEALTH_PATH || req.url.startsWith(`${HEALTH_PATH}?`)) {
			const nonce = new URL(req.url, 'http://x').searchParams.get('nonce') || '';
			const proof = this.secret && nonce ? crypto.createHmac('sha256', this.secret).update(nonce).digest('hex') : null;
			const body = JSON.stringify({ id: ROUTER_ID, version: this.version, pid: process.pid, proof });
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(body);
		}
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', async () => {
			const raw = Buffer.concat(chunks);
			let json = null;
			if (raw.length && /json/i.test(req.headers['content-type'] || '')) {
				try { json = JSON.parse(raw.toString('utf8')); } catch (_) { json = null; }
			}
			const model = json && json.model;
			let rawOut = raw;
			let jsonOut = json;
			const headers = { ...req.headers };
			delete headers.host;
			let headersOut = headers;
			let onDone = null;
			if (routeFor(model) === 'openrouter' && req.method === 'POST' && req.url.startsWith('/v1/messages')) {
				if (!isServerToolRequest(json)) return this._toOpenRouter(req, res, json);
				// Web search from an OpenRouter chat: Anthropic runs it on a Claude
				// model under the user's own Claude login.
				const rewritten = serverToolRequest(json, headers, this.serverToolModel);
				jsonOut = rewritten.body;
				headersOut = rewritten.headers;
				rawOut = Buffer.from(JSON.stringify(jsonOut));
				const started = Date.now();
				onDone = (status, buf) => {
					const error = status >= 400 ? errorText(buf) : '';
					this.log(`model router: ${bareModel(model)} web search on ${this.serverToolModel} -> ${status} ${Date.now() - started}ms${error ? ` ${error}` : ''}`);
				};
			}
			this.stats.anthropic++;
			const body = req.method === 'GET' || req.method === 'HEAD' ? null : anthropicBody(rawOut, jsonOut);
			forward(this.anthropicBase, req, res, body, headersOut, onDone);
		});
	}

	async _toOpenRouter(req, res, json) {
		this.stats.openrouter++;
		const started = Date.now();
		const key = await this.getKey();
		if (!key) {
			this.stats.errors++;
			// Not 401: Claude Code reads a 401 as its own expired login and
			// asks for /login.
			return anthropicError(res, 400, 'invalid_request_error',
				'Agent View model router: no OpenRouter key. Run "Agent View: Set OpenRouter API Key" or set the OPENROUTER_API_KEY environment variable.');
		}
		if (req.url.startsWith('/v1/messages/count_tokens')) {
			// OpenRouter has no token counter for these models; a rough
			// four-characters-per-token estimate keeps Claude Code's context
			// gauge moving.
			const body = JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(json.messages || []).length / 4) });
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(body);
		}
		const model = bareModel(json.model);
		let policy;
		// The policy carries the provider ignore list, so a request never leaves
		// without one.
		try { policy = await this.getPolicy(model); } catch (err) {
			const why = err && err.message ? err.message : String(err);
			this.log(`model router: provider policy failed (${why}); request refused`);
			// 400: Claude Code shows it at once; a 5xx would sit through its
			// retries first.
			return anthropicError(res, 400, 'invalid_request_error', `Agent View model router: request not sent, no provider policy (${why}).`);
		}
		let modelInfo = { images: false, documents: false };
		try { modelInfo = (await this.getModelInfo(model)) || modelInfo; } catch (_) { /* text-only */ }
		const sessionId = sessionIdOf(json) || req.headers['x-claude-code-session-id'] || null;
		const ranked = Array.isArray(policy.order) ? policy.order.slice() : [];
		policy = this._stickyFirst(sessionId, model, this._withoutCooling(model, policy));
		const headers = {};
		for (const [k, v] of Object.entries(req.headers)) if (!DROP_TO_OPENROUTER.has(k)) headers[k] = v;
		headers.authorization = `Bearer ${key}`;
		headers['content-type'] = 'application/json';
		if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
		headers['http-referer'] = 'https://github.com/tuscheteam/agent-view';
		headers['x-title'] = 'Agent View';

		let aborted = false;
		let current = null;
		res.on('close', () => { if (!res.writableFinished) { aborted = true; if (current) current.destroy(); } });

		// OpenRouter tries the ordered providers but does not move on when one
		// rejects the request itself (HTTP 400). The router then retries without
		// that provider, up to twice. A provider that rejected a request another
		// one then served is dropped for this model; one that was only busy
		// (429, 5xx) rests for a few minutes. A genuine context overflow costs
		// two extra instant 400s before it reaches Claude Code.
		const failed = [];
		for (let attempt = 0; ; attempt++) {
			const body = Buffer.from(JSON.stringify(openRouterBody(json, policy, sessionId, modelInfo)));
			let upRes;
			try {
				upRes = await openUpstream(this.openRouterBase, req, body, headers, (r) => { current = r; });
			} catch (err) {
				this.stats.errors++;
				if (!aborted && !res.headersSent) anthropicError(res, 502, 'api_error', `Agent View model router: OpenRouter unreachable (${err.code || err.message}).`);
				return;
			}
			if (aborted) { upRes.resume(); return; }
			const status = upRes.statusCode || 502;
			const order = Array.isArray(policy.order) ? policy.order : [];
			if (status >= 400) {
				const buf = await readAll(upRes);
				const error = errorInfo(buf);
				const culprit = slugForProvider(error.provider, order) || order[0];
				const retryable = (status === 400 || status === 408 || status === 429 || status >= 500) && attempt < 2 && order.length > 1 && culprit;
				if (retryable && !aborted) {
					failed.push({ slug: culprit, status, error: error.text });
					if (status !== 400) this._cool(model, culprit);
					policy = { ...policy, order: order.filter((s) => s !== culprit), ...(Array.isArray(policy.only) ? { only: policy.only.filter((s) => s !== culprit) } : {}) };
					this.log(`model router: ${model} ${culprit} -> ${status} ${error.text}; retrying on ${policy.order[0]}`);
					continue;
				}
				this.stats.errors++;
				const entry = { model, status, ms: Date.now() - started, provider: error.provider, cost: null, id: null, error: error.text };
				this._note(entry);
				this.log(`model router: ${model} -> ${status} ${error.text}`);
				if (aborted) return;
				const resHeaders = {};
				for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k) && k !== 'content-length') resHeaders[k] = v;
				resHeaders['content-length'] = buf.length;
				res.writeHead(status, resHeaders);
				res.end(buf);
				return;
			}
			for (const f of failed) {
				if (f.status === 400) this.onReject(model, f.slug, `rejected a Claude Code request (HTTP 400: ${f.error.slice(0, 120)})`);
			}
			const streamed = /event-stream/i.test(String(upRes.headers['content-type'] || ''));
			const resHeaders = {};
			for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k) && k !== 'content-length') resHeaders[k] = v;
			const finish = (bufAll) => {
				const info = usageOf(bufAll, upRes.headers);
				this._rememberProvider(sessionId, model, info, policy, ranked);
				const entry = { model, status, ms: Date.now() - started, provider: info.provider, cost: info.cost, id: info.id, cacheRead: info.cacheRead };
				this._note(entry);
				this.log(`model router: ${model} -> ${status} ${entry.provider || '?'} ${entry.ms}ms${entry.cost != null ? ` $${entry.cost.toFixed(6)}` : ''}${info.cacheRead ? ` cache ${info.cacheRead}` : ''}${failed.length ? ` after ${failed.map((f) => f.slug).join(', ')} failed` : ''}`);
				this.onUsage(entry);
			};
			if (!streamed) {
				const raw = await readAll(upRes);
				let out = raw;
				try {
					const j = JSON.parse(raw.toString('utf8'));
					if (rewriteToolIdsInMessage(j)) out = Buffer.from(JSON.stringify(j));
				} catch (_) { /* pass through */ }
				if (aborted) return;
				resHeaders['content-length'] = out.length;
				res.writeHead(status, resHeaders);
				res.end(out);
				finish(raw);
				return;
			}
			res.writeHead(status, resHeaders);
			relayBreaks(upRes, res);
			const rewriter = new ToolIdRewriter();
			const chunks = [];
			upRes.on('data', (c) => {
				chunks.push(c);
				const out = rewriter.push(c);
				if (out) res.write(out);
			});
			upRes.on('end', () => {
				const rest = rewriter.flush();
				if (rest) res.write(rest);
				res.end();
				finish(Buffer.concat(chunks));
			});
			return;
		}
	}

	// A chat stays with the provider that served it while that provider's
	// prompt cache is warm. OpenRouter's own stickiness is off whenever an
	// order is sent, and busy cheap providers otherwise make a chat hop and
	// re-pay its whole context at full input price.
	_stickyFirst(sessionId, model, policy) {
		if (!sessionId || !Array.isArray(policy.order) || policy.order.length < 2) return policy;
		const s = this.sticky.get(`${sessionId}|${model}`);
		if (!s || s.until < Date.now() || !policy.order.includes(s.slug) || policy.order[0] === s.slug) return policy;
		return { ...policy, order: [s.slug, ...policy.order.filter((x) => x !== s.slug)] };
	}

	// Pin the serving provider only when its cache actually hit, or when it is
	// the cheapest ranked one anyway. A pricier fallback that served one turn
	// with a cold cache must not hold the chat.
	_rememberProvider(sessionId, model, info, policy, ranked) {
		if (!sessionId) return;
		const key = `${sessionId}|${model}`;
		const slug = slugForProvider(info.provider, policy.order);
		if (!slug) return;
		if (info.cacheRead > 0 || slug === ranked[0]) {
			this.sticky.set(key, { slug, until: Date.now() + STICKY_MS });
		} else {
			this.sticky.delete(key);
		}
		if (this.sticky.size > 500) {
			const now = Date.now();
			for (const [k, v] of this.sticky) if (v.until < now) this.sticky.delete(k);
		}
	}

	// Busy providers (429, 5xx) are skipped for a few minutes so each request
	// does not pay a failed attempt first.
	_cool(model, slug) {
		this.cooling.set(`${model}|${slug}`, Date.now() + COOL_MS);
	}

	_withoutCooling(model, policy) {
		if (!Array.isArray(policy.order) || policy.order.length < 2) return policy;
		const now = Date.now();
		const warm = policy.order.filter((s) => !((this.cooling.get(`${model}|${s}`) || 0) > now));
		if (!warm.length || warm.length === policy.order.length) return policy;
		return { ...policy, order: warm, ...(Array.isArray(policy.only) ? { only: policy.only.filter((s) => warm.includes(s)) } : {}) };
	}
}

function readAll(stream) {
	return new Promise((resolve) => {
		const chunks = [];
		stream.on('data', (c) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', () => resolve(Buffer.concat(chunks)));
		stream.on('aborted', () => resolve(Buffer.concat(chunks)));
	});
}

// Opens an upstream request and resolves with its response before any byte
// reaches the client, so a rejected attempt can be retried unseen.
function openUpstream(base, req, body, headers, onRequest) {
	return new Promise((resolve, reject) => {
		const target = new URL(base);
		const pathPrefix = target.pathname.replace(/\/$/, '');
		const lib = target.protocol === 'http:' ? http : https;
		const upstream = lib.request({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || undefined,
			path: pathPrefix + req.url,
			method: req.method,
			headers: { ...headers, host: target.host, 'content-length': body.length },
		}, resolve);
		upstream.on('error', reject);
		if (onRequest) onRequest(upstream);
		upstream.end(body);
	});
}

// Is the router of another Agent View window answering on this port? With a
// secret, the answer must carry an HMAC of a fresh nonce under that secret.
function probe(port, { secret = null, timeoutMs = 1500 } = {}) {
	return new Promise((resolve) => {
		const nonce = crypto.randomBytes(16).toString('hex');
		// agent:false: a kept-alive socket to a router that just closed would fail.
		const req = http.get({ hostname: '127.0.0.1', port, path: `${HEALTH_PATH}?nonce=${nonce}`, timeout: timeoutMs, agent: false }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => {
				try {
					const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					if (!j || j.id !== ROUTER_ID) return resolve(null);
					if (secret) {
						const expected = crypto.createHmac('sha256', secret).update(nonce).digest('hex');
						const got = String(j.proof || '');
						if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return resolve(null);
					}
					resolve(j);
				} catch (_) { resolve(null); }
			});
		});
		req.on('timeout', () => { req.destroy(); resolve(null); });
		req.on('error', () => resolve(null));
	});
}

module.exports = {
	ModelRouter,
	probe,
	ROUTER_ID,
	HEALTH_PATH,
	DEFAULT_PORT,
	_internal: {
		routeFor, bareModel, filterThinking, anthropicBody, openRouterBody, transformForOpenRouter, sessionIdOf, usageOf,
		isServerToolRequest, serverToolRequest, stripPatterns, errorText, errorInfo, slugForProvider, replaceMedia,
		ToolIdRewriter, rewriteToolIdsInMessage, toolIdFor,
	},
};
