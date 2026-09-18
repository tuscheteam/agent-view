const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { UsageCache, watchCredentials } = require('./usage');
const restyle = require('./restyle');
const { UsageViewProvider } = require('./usageView');
const { LeaderboardCache, DEFAULT_SUBAGENT_EXCLUDE } = require('./leaderboard');
const { LeaderboardViewProvider, infoLines } = require('./leaderboardView');

// A CHATS tree of our own, because the built-in OPEN EDITORS rows cannot carry
// extra information: Claude chats are createWebviewPanel("claudeVSCodePanel")
// tabs with no URI, so even a FileDecorationProvider badge has nothing to
// attach to, and MenuId.OpenEditorsContext is not exposed to extensions.
//
// The numbers come from Claude Code's own session transcripts —
// ~/.claude/projects/<slug>/<session-id>.jsonl — which carry a `custom-title`
// record holding the exact tab label, plus one `usage` block per assistant
// message. That title record is what lets us line a transcript up with a tab.

// Per-million-token rates. Cache reads bill at 0.1x input; cache writes at
// 1.25x for the 5-minute TTL and 2x for the 1-hour one.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

const PRICING = {
	'claude-fable-5': { in: 10, out: 50, ctx: 1000000 },
	'claude-mythos-5': { in: 10, out: 50, ctx: 1000000 },
	'claude-opus-5': { in: 5, out: 25, ctx: 1000000 },
	'claude-opus-4-8': { in: 5, out: 25, ctx: 1000000 },
	'claude-opus-4-7': { in: 5, out: 25, ctx: 1000000 },
	'claude-opus-4-6': { in: 5, out: 25, ctx: 1000000 },
	'claude-opus-4-5': { in: 5, out: 25, ctx: 200000 },
	'claude-sonnet-5': { in: 3, out: 15, ctx: 1000000 },
	'claude-sonnet-4-6': { in: 3, out: 15, ctx: 1000000 },
	'claude-sonnet-4-5': { in: 3, out: 15, ctx: 1000000 },
	'claude-haiku-4-5': { in: 1, out: 5, ctx: 200000 },
};
const DEFAULT_RATES = PRICING['claude-opus-5'];

function ratesFor(model) {
	if (!model) return DEFAULT_RATES;
	// Transcripts store the bare id ("claude-opus-5"); a dated or suffixed
	// variant still starts with it.
	const hit = Object.keys(PRICING).find((id) => model.startsWith(id));
	return hit ? PRICING[hit] : DEFAULT_RATES;
}

// ~/.claude/projects/c--Users-alice-projects-my-app — every
// character that is not alphanumeric becomes a hyphen, drive colon and
// underscores included.
function projectDirFor(workspacePath) {
	const root = path.join(claudeConfigDir(), 'projects');
	const slug = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
	const exact = path.join(root, slug);
	if (fs.existsSync(exact)) return exact;
	// Case can differ on the drive letter depending on who reported the path.
	try {
		const match = fs.readdirSync(root).find((d) => d.toLowerCase() === slug.toLowerCase());
		if (match) return path.join(root, match);
	} catch (_) { /* no projects dir yet */ }
	return null;
}

function claudeConfigDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Streamed line by line: long-running sessions grow transcripts into the
// tens of megabytes, and
// reading those whole would spike memory every refresh.
function stampOf(record, fallback) {
	const ms = Date.parse(record.timestamp || '');
	return Number.isNaN(ms) ? fallback : ms;
}

async function readTranscript(file) {
	const totals = { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 };
	// tool_use id -> tool name, cleared when the matching tool_result lands.
	// Whatever is still here at EOF is what the agent is waiting on.
	const pending = new Map();
	// Every title the session ever carried. A rename appends a new record, but
	// resume can replay stale ones after it — one real transcript ended on the
	// OLD title while its tab showed the new one. The last record is therefore
	// not authoritative; any recorded title may be the one on the tab.
	const titles = new Set();
	let customTitle = null;
	let aiTitle = null;
	let model = null;
	let contextTokens = 0;
	let cost = 0;
	let messages = 0;
	let lastStop = null;
	// When the agent last finished speaking, and when you last spoke. Both drive
	// the unread mark: a reply newer than your own last turn is one you have not
	// answered, and typing is proof you had read what came before it.
	let lastReplyAt = 0;
	let lastUserAt = 0;

	const rl = readline.createInterface({
		input: fs.createReadStream(file, { encoding: 'utf8' }),
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		if (!line) continue;
		let record;
		try { record = JSON.parse(line); } catch (_) { continue; }

		if (record.type === 'custom-title' && record.customTitle) { customTitle = record.customTitle; titles.add(record.customTitle); }
		else if (record.type === 'ai-title' && record.aiTitle) { aiTitle = record.aiTitle; titles.add(record.aiTitle); }

		const message = record.message;
		if (message && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === 'tool_use') pending.set(block.id, block.name);
				else if (block.type === 'tool_result') pending.delete(block.tool_use_id);
			}
		}
		if (message && message.role === 'assistant' && message.stop_reason !== undefined) {
			lastStop = message.stop_reason;
			if (message.stop_reason === 'end_turn') lastReplyAt = stampOf(record, lastReplyAt);
		}
		// A real turn you typed. Tool results and injected context also arrive as
		// role "user", so they are excluded — they prove nothing about reading.
		if (record.type === 'user' && !record.isMeta && !record.isSidechain && message
			&& !(Array.isArray(message.content) && message.content.some((b) => b.type === 'tool_result'))) {
			lastUserAt = stampOf(record, lastUserAt);
		}

		const usage = message && message.usage;
		if (!usage) continue;

		// Last one wins, so the row follows a mid-chat model switch. `<synthetic>`
		// marks a replayed turn, not a model, and must not overwrite it.
		if (message.model && message.model !== '<synthetic>') model = message.model;
		const rates = ratesFor(message.model);

		const creation = usage.cache_creation || {};
		const write1h = creation.ephemeral_1h_input_tokens || 0;
		// Older records carry only the total, so derive the 5-minute share
		// rather than dropping it.
		const writeTotal = usage.cache_creation_input_tokens || 0;
		const write5m = creation.ephemeral_5m_input_tokens || Math.max(0, writeTotal - write1h);
		const input = usage.input_tokens || 0;
		const output = usage.output_tokens || 0;
		const cacheRead = usage.cache_read_input_tokens || 0;

		totals.input += input;
		totals.output += output;
		totals.cacheRead += cacheRead;
		totals.write5m += write5m;
		totals.write1h += write1h;
		messages++;

		cost += (input * rates.in
			+ output * rates.out
			+ cacheRead * rates.in * CACHE_READ
			+ write5m * rates.in * CACHE_WRITE_5M
			+ write1h * rates.in * CACHE_WRITE_1H) / 1000000;

		// Context in play is whatever the most recent request carried, not the
		// running total — cache reads replay the same prefix every turn.
		contextTokens = input + cacheRead + writeTotal;
	}

	return {
		title: customTitle || aiTitle,
		titles,
		model,
		contextTokens,
		contextLimit: ratesFor(model).ctx,
		cost,
		messages,
		totals,
		lastStop,
		lastReplyAt,
		lastUserAt,
		pendingTools: [...pending.values()],
	};
}

// ── Subagents ──────────────────────────────────────────────────────────────
// Each subagent writes its own transcript under the session's directory:
//   <session>/subagents/agent-*.jsonl                (Agent-tool spawns)
//   <session>/subagents/workflows/wf_*/agent-*.jsonl (Workflow runs)
// A file still being written is a subagent still working — there is no other
// completion record to read, and none is needed: mtime within the window says
// "running", and the first line's prompt text names the agent.
const SUBAGENT_ACTIVE_MS = 120000;

// Frames of the cli-spinners "dots" set. Child rows draw one as label text
// so a running agent reads as work in progress; one shared frame index keeps
// every row in step. A 200 ms timer advances it, with two guards learned the
// hard way. The 0.13.9 timer fired a refresh for EVERY parent row per 80 ms
// tick, and that starved VS Code's tree: AsyncDataTree.refreshNode makes a
// root refresh wait for every in-flight child refresh that intersects it,
// re-checking after each one resolves — with child refreshes arriving faster
// than they completed, the root refresh (file watchers, the 45 s sweep)
// never got a gap, and the panel sat frozen for 10+ minutes while agents
// finished underneath it. 0.13.10 dropped the timer and advanced the frame
// once per root render, which starved nothing but crawled — the glyph moved
// only when a watcher or the sweep happened to fire. So now: each tick
// repaints ONE parent row, round-robin, and while a root refresh is pending
// or running the tick fires nothing at all (see spinnerTick).
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 200;
// A requested root refresh that never lands (a throw inside getChildren, a
// disposed view) would otherwise mute the spinner forever; past this age the
// pending flag is treated as stale and dropped.
const ROOT_PENDING_MAX_MS = 10000;
const subagentCache = new Map();

// Claude Code writes agent-<id>.meta.json next to each subagent transcript at
// spawn time: {"agentType","description","workflowPhase","model",...}. The
// description is the one-line name the spawner gave the agent — a far better
// row label than a heading fished out of the prompt. The file never changes
// after spawn, so a successful parse is cached for the life of the process; a
// missing file (older Claude Code builds) or a malformed one reads as null and
// stays silent.
const subagentMetaCache = new Map();

function readSubagentMeta(transcriptFile) {
	const metaFile = transcriptFile.replace(/\.jsonl$/, '.meta.json');
	if (subagentMetaCache.has(metaFile)) return subagentMetaCache.get(metaFile);
	let meta = null;
	try {
		const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
		if (parsed && typeof parsed === 'object') meta = parsed;
	} catch (_) { /* absent or malformed — the prompt-derived name covers it */ }
	// Only a parsed meta is cached: the transcript can appear a beat before the
	// meta file during spawn, and a cached null would hide it forever.
	if (meta) subagentMetaCache.set(metaFile, meta);
	return meta;
}

// Subagents bill against the same account as the chat that spawned them, and
// their transcripts carry the same per-message `usage` and `model` fields — but
// they are separate files, so a parent chat's own transcript understates what
// the work cost.
function readSubagentSummary(file, stat) {
	const cached = subagentCache.get(file);
	// A summary built before meta.json landed must not stick for a transcript
	// that never changes again: on such a hit, re-check for the meta file once
	// per refresh and rebuild only when it has appeared.
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
		&& (cached._metaApplied || !readSubagentMeta(file))) return cached;

	const summary = {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		model: null,
		name: null,
		// From the spawn meta file: what kind of agent this is (general-purpose,
		// Explore, workflow-subagent), which workflow phase spawned it, and the
		// model it was requested with — the transcript only knows the model once
		// the first assistant message lands.
		kind: null,
		phase: null,
		metaModel: null,
		messages: 0,
		cost: 0,
		totals: { input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 },
	};

	const meta = readSubagentMeta(file);
	summary._metaApplied = !!meta;
	if (meta) {
		if (typeof meta.description === 'string' && meta.description.trim()) {
			const desc = meta.description.trim();
			// Same cap style as threadLabel, tighter: a child row shares its line
			// with model/tokens/age/cost.
			if (desc.length > 40) {
				let cut = desc.slice(0, 39);
				// The cut can land inside a surrogate pair; a lone high surrogate
				// renders as U+FFFD in the tree, so drop it before the ellipsis.
				if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
				summary.name = `${cut.trimEnd()}…`;
			} else {
				summary.name = desc;
			}
		}
		if (typeof meta.agentType === 'string') summary.kind = meta.agentType;
		if (typeof meta.workflowPhase === 'string') summary.phase = meta.workflowPhase;
		if (typeof meta.model === 'string') summary.metaModel = meta.model;
	}

	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return summary; }

	for (const line of text.split('\n')) {
		if (!line) continue;
		let record;
		try { record = JSON.parse(line); } catch (_) { continue; }
		const message = record.message;
		if (!message) continue;

		if (!summary.name && message.role === 'user') summary.name = promptLabel(message.content);
		// `<synthetic>` is what a replayed or cached turn reports; it is not a
		// model and would price at the default rate.
		if (message.model && message.model !== '<synthetic>') summary.model = message.model;

		const usage = message.usage;
		if (!usage) continue;
		const rates = ratesFor(message.model);
		const creation = usage.cache_creation || {};
		const write1h = creation.ephemeral_1h_input_tokens || 0;
		const writeTotal = usage.cache_creation_input_tokens || 0;
		const write5m = creation.ephemeral_5m_input_tokens || Math.max(0, writeTotal - write1h);
		const input = usage.input_tokens || 0;
		const output = usage.output_tokens || 0;
		const cacheRead = usage.cache_read_input_tokens || 0;

		summary.messages++;
		summary.totals.input += input;
		summary.totals.output += output;
		summary.totals.cacheRead += cacheRead;
		summary.totals.write5m += write5m;
		summary.totals.write1h += write1h;
		summary.cost += (input * rates.in
			+ output * rates.out
			+ cacheRead * rates.in * CACHE_READ
			+ write5m * rates.in * CACHE_WRITE_5M
			+ write1h * rates.in * CACHE_WRITE_1H) / 1000000;
	}

	subagentCache.set(file, summary);
	return summary;
}

// Naming an agent is harder than it looks. Fanned-out agents share a long
// briefing and differ only near the end, so the first line labels them all
// identically (the shared briefing headline, once per auditor). The
// workflow journal is no help either — its records carry an agentId and a hash,
// no label.
//
// What does distinguish them is the last heading of the briefing, which is
// where the per-agent assignment sits: "YOUR AREA: webhook + automation
// scripts", "YOUR JOB: verify another agent's change list". Prefer that, then
// an explicit task line, then the first line that is not shared boilerplate.
const PROMPT_BOILERPLATE = /^(repo root|context|cwd|working directory|you are|read carefully)\b/i;
const PROMPT_ASSIGNMENT = /^(your (area|job|task|assignment|slice|scope)|task|objective|goal)\b[:\s]/i;

function promptLabel(content) {
	let text = content;
	if (Array.isArray(text)) {
		const block = text.find((b) => b.type === 'text' && b.text);
		text = block ? block.text : null;
	}
	if (typeof text !== 'string') return null;

	const clean = (line) => line.replace(/^[#>*\-\s]+/, '').replace(/[*`]/g, '').trim();
	const lines = text.split('\n');
	const headings = lines.filter((l) => /^#{1,6}\s/.test(l.trim())).map(clean);

	const assignment = [...headings].reverse().find((h) => PROMPT_ASSIGNMENT.test(h))
		|| lines.map(clean).find((l) => PROMPT_ASSIGNMENT.test(l))
		|| headings[headings.length - 1];
	if (assignment) return assignment.slice(0, 70);

	const body = lines.map(clean)
		.filter((l) => l.length > 12 && !PROMPT_BOILERPLATE.test(l) && !/^[-=]+$/.test(l));
	return body.length ? body[0].slice(0, 70) : null;
}

// Every subagent of a session, running or finished — the parent's totals need
// all of them, while the child rows only show the ones still writing.
function allSubagentFiles(projectDir, sessionId) {
	const base = path.join(projectDir, sessionId, 'subagents');
	const dirs = [base];
	try {
		for (const d of fs.readdirSync(path.join(base, 'workflows'))) {
			dirs.push(path.join(base, 'workflows', d));
		}
	} catch (_) { /* no workflow runs */ }

	const files = [];
	for (const dir of dirs) {
		let names;
		try { names = fs.readdirSync(dir); } catch (_) { continue; }
		for (const name of names) {
			if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
			const full = path.join(dir, name);
			try { files.push({ file: full, id: name.replace(/^agent-|\.jsonl$/g, ''), stat: fs.statSync(full) }); } catch (_) { /* vanished */ }
		}
	}
	return files;
}

function subagentsFor(projectDir, sessionId, now = Date.now()) {
	const all = allSubagentFiles(projectDir, sessionId).map((entry) => {
		const summary = readSubagentSummary(entry.file, entry.stat);
		return { id: entry.id, ...summary, running: now - entry.stat.mtimeMs <= SUBAGENT_ACTIVE_MS };
	});
	all.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		all,
		running: all.filter((a) => a.running),
		cost: all.reduce((sum, a) => sum + a.cost, 0),
		messages: all.reduce((sum, a) => sum + a.messages, 0),
	};
}

// A session writes ~/.claude/sessions/<pid>.json while its process is alive.
// Needed because an unanswered tool_use also survives a crashed or closed
// chat, which would otherwise read as "running" forever.
function liveSessionIds() {
	const ids = new Set();
	const dir = path.join(claudeConfigDir(), 'sessions');
	let names;
	try { names = fs.readdirSync(dir); } catch (_) { return ids; }
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
			if (rec.sessionId) ids.add(rec.sessionId);
		} catch (_) { /* being written right now */ }
	}
	return ids;
}

// Only states that want something from you earn a dot. A chat you have already
// read is the resting state and stays unmarked, or every row would carry a
// badge and none of them would mean anything.
function stateOf(entry, live, seen) {
	if (!entry) return 'unknown';
	if (!live) return seen && seen.isUnread(entry) ? 'unread' : 'idle';
	// An aborted turn leaves its tool_use blocks unanswered forever, so a
	// non-empty pending list is not on its own proof of work in flight. The
	// last assistant message's stop_reason is: `tool_use` means the turn is
	// still mid-flight, `end_turn` means it closed and the leftovers are stale.
	if (entry.lastStop !== 'tool_use') return seen && seen.isUnread(entry) ? 'unread' : 'idle';
	if (entry.pendingTools.includes('AskUserQuestion')) return 'question';
	return 'running';
}

// Cached by mtime+size so a refresh only re-reads transcripts that actually
// changed; without it every tab switch would re-parse the whole store.
class TranscriptIndex {
	constructor() {
		this.byFile = new Map();
		this.byTitle = new Map();
		this.scanning = null;
	}

	async refresh(workspacePath) {
		if (this.scanning) return this.scanning;
		this.scanning = this._scan(workspacePath).finally(() => { this.scanning = null; });
		return this.scanning;
	}

	async _scan(workspacePath) {
		const dir = workspacePath && projectDirFor(workspacePath);
		if (!dir) return;

		let files;
		try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return; }

		const titles = new Map();
		for (const name of files) {
			const file = path.join(dir, name);
			let stat;
			try { stat = fs.statSync(file); } catch (_) { continue; }

			const cached = this.byFile.get(file);
			let entry;
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				entry = cached;
			} else {
				try {
					entry = await readTranscript(file);
				} catch (_) {
					continue; // half-written line during an active session
				}
				entry.mtimeMs = stat.mtimeMs;
				entry.size = stat.size;
				entry.sessionId = name.replace(/\.jsonl$/, '');
				this.byFile.set(file, entry);
			}
			entry.lastActivity = stat.mtimeMs;

			// Index under every title the session ever carried, so a tab whose
			// label is an earlier name still finds its transcript. Newest entry
			// wins when sessions share a title.
			for (const t of entry.titles || (entry.title ? [entry.title] : [])) {
				const key = t.trim().toLowerCase();
				const existing = titles.get(key);
				if (!existing || entry.lastActivity > existing.lastActivity) titles.set(key, entry);
			}
		}
		this.byTitle = titles;
	}

	lookup(label) {
		return label ? this.byTitle.get(label.trim().toLowerCase()) : undefined;
	}

	// Fallback for tabs the title index cannot place: a brand-new chat has no
	// title record yet, and a just-renamed chat has a label no record carries.
	// Candidates are unclaimed transcripts that are either running right now
	// (their session id appears in ~/.claude/sessions) or untitled and recent.
	// Live beats recent: a running session's transcript belongs to SOME open
	// tab, however old its last write.
	unclaimedSince(cutoffMs, claimed, live) {
		let best = null;
		const rank = (entry) => (live && live.has(entry.sessionId) ? 1 : 0);
		for (const entry of this.byFile.values()) {
			if (claimed.has(entry.sessionId)) continue;
			const isLive = live && live.has(entry.sessionId);
			if (!isLive && (entry.title || entry.lastActivity < cutoffMs)) continue;
			if (!best || rank(entry) > rank(best)
				|| (rank(entry) === rank(best) && entry.lastActivity > best.lastActivity)) best = entry;
		}
		if (best) claimed.add(best.sessionId);
		return best;
	}
}

// ── Codex ──────────────────────────────────────────────────────────────────
// The ChatGPT extension opens a conversation as a custom editor whose URI is
// openai-codex://route/local/<conversationId> (or /remote/), and keeps thread
// metadata in ~/.codex/state_5.sqlite. Unlike Claude, the tab carries a real
// URI, so rows key off the conversation id rather than the title.
const CODEX_VIEW_TYPE = 'chatgpt.conversationEditor';
// A Codex chat can also run inside Codex's own sidebar view (no editor tab),
// and a CLOUD task writes nothing locally at all while it works — thread row,
// recency and rollout file all sit still (measured 146 minutes stale on an
// actively working chat). Liveness is therefore unprovable from disk; a
// recently touched thread gets the benefit of the doubt and renders as a live
// row. Local work keeps the row honest through the rollout file's mtime.
const CODEX_LIVE_MS = 3 * 60 * 60 * 1000;
const CODEX_SCHEME = 'openai-codex';
const CODEX_AUTHORITY = 'route';

// node:sqlite is unflagged from Node 23 on; the extension host may be older,
// in which case we fall back to the plain-JSONL index below.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* fallback path */ }

function codexDir() {
	// CODEX_HOME is Codex's own override for ~/.codex; honouring it also lets
	// tests point the index at a fixture directory.
	return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Codex bumps its schema by renaming the database (state_5.sqlite →
// state_6.sqlite) and leaves the old file behind, so a pinned filename goes
// stale on the next bump. Pick the highest N present.
function codexStateDb() {
	let best = null;
	let bestN = -1;
	try {
		for (const name of fs.readdirSync(codexDir())) {
			const m = /^state_(\d+)\.sqlite$/.exec(name);
			if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = path.join(codexDir(), name); }
		}
	} catch (_) { /* no ~/.codex at all */ }
	return best;
}

// The guardian prompt preamble. Codex's guardian review threads open to an
// empty chat; on builds that store them with thread_source NULL and no
// parseable source blob, this first line of their title is the only marker
// left to drop them by.
const CODEX_GUARDIAN_PREAMBLE = 'The following is the Codex agent history';

function isGuardianTitle(text) {
	return typeof text === 'string' && text.startsWith(CODEX_GUARDIAN_PREAMBLE);
}

function codexConversationId(uri) {
	if (!uri || uri.scheme !== CODEX_SCHEME || uri.authority !== CODEX_AUTHORITY) return null;
	const parts = uri.path.replace(/^\//, '').split('/');
	if (parts.length < 2) return null;
	return (parts[0] === 'local' || parts[0] === 'remote') ? parts[1] : null;
}

// Codex records a subagent as a thread of its own, alongside the chat that
// spawned it: same table, same shape, `thread_source` = "subagent" and a
// `source` JSON naming the parent. One conversation that fans out to nine
// helpers therefore stores ten threads, and listing the table as-is showed
// nine phantom chats, each titled with the parent's first message.
class CodexIndex {
	constructor() {
		this.byId = new Map();
		this.subagentsByParent = new Map();
		this.source = 'none';
		this.sourceFile = null; // basename of the sqlite db actually read
	}

	subagentsFor(threadId, activeSince) {
		const all = this.subagentsByParent.get(threadId) || [];
		return all.filter((sub) => sub.lastActivity >= activeSince);
	}

	refresh() {
		if (DatabaseSync && this._fromDatabase()) return;
		this._fromSessionIndex();
	}

	_fromDatabase() {
		const file = codexStateDb();
		if (!file) return false;
		let db;
		try {
			// Read-only, always: Codex owns this database and may be writing it.
			db = new DatabaseSync(file, { readOnly: true });
			// Older Codex builds ship fewer columns; selecting a column that is
			// not there throws, which used to dump the whole install on the
			// JSONL fallback. Ask the schema first; a missing column simply
			// reads as null on every row.
			const have = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
			const wanted = ['id', 'name', 'title', 'tokens_used', 'model', 'reasoning_effort',
				'updated_at_ms', 'archived', 'thread_source', 'source', 'agent_nickname',
				'agent_path', 'rollout_path', 'recency_at_ms', 'first_user_message'];
			const cols = wanted.filter((c) => have.has(c));
			if (!cols.includes('id')) return false;
			const rows = db.prepare(`SELECT ${cols.join(', ')} FROM threads`).all();
			const next = new Map();
			const children = new Map();
			for (const row of rows) {
				// `codex exec` batch runs share the table but are not chats
				// anyone opened — one host showed 200+ of them as closed rows.
				if (row.source === 'exec') continue;
				// Last-resort guard for guardian rows a build stored with
				// neither thread_source='subagent' nor a parseable source blob.
				if (isGuardianTitle(row.name) || isGuardianTitle(row.title) || isGuardianTitle(row.first_user_message)) continue;
				const entry = {
					title: row.name || row.title,
					tokens: Number(row.tokens_used) || 0,
					model: row.model,
					effort: row.reasoning_effort,
					lastActivity: Number(row.updated_at_ms) || 0,
					archived: !!row.archived,
				};
				// updated_at_ms stalls the moment work goes to the cloud; the
				// rollout file keeps moving for local work. Take the newest of
				// the three signals.
				try {
					if (row.rollout_path) {
						const mtime = fs.statSync(row.rollout_path).mtimeMs;
						if (mtime > entry.lastActivity) entry.lastActivity = mtime;
					}
				} catch (_) { /* rollout gone or unreadable */ }
				if (Number(row.recency_at_ms) > entry.lastActivity) entry.lastActivity = Number(row.recency_at_ms);
				// Some builds leave thread_source NULL on subagent rows, so the
				// source blob is an equal authority on what spawned the thread.
				if (row.thread_source === 'subagent' || subagentSource(row.source)) {
					const parent = parentThreadId(row.source);
					// A subagent with no traceable parent is dropped rather than
					// listed: it is still not a chat anyone opened.
					if (!parent) continue;
					entry.id = row.id;
					entry.name = row.agent_nickname
						|| (row.agent_path ? String(row.agent_path).split('/').filter(Boolean).pop() : null)
						|| (row.model === 'codex-auto-review' ? 'review' : 'agent');
					const list = children.get(parent) || [];
					list.push(entry);
					children.set(parent, list);
					continue;
				}
				next.set(row.id, entry);
			}
			for (const list of children.values()) list.sort((a, b) => b.lastActivity - a.lastActivity);
			this.byId = next;
			this.subagentsByParent = children;
			this.source = 'sqlite';
			this.sourceFile = path.basename(file);
			return true;
		} catch (_) {
			return false; // locked, WAL unreadable, or an older schema
		} finally {
			if (db) { try { db.close(); } catch (_) { /* already gone */ } }
		}
	}

	// Names and timestamps only — enough to render a row when sqlite is out of
	// reach, just without token counts.
	_fromSessionIndex() {
		const file = path.join(codexDir(), 'session_index.jsonl');
		let text;
		try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
		const next = new Map();
		for (const line of text.split('\n')) {
			if (!line) continue;
			try {
				const rec = JSON.parse(line);
				if (!rec.id) continue;
				// Same guardian guard as the sqlite path — the JSONL index has
				// no thread_source field to filter on.
				if (isGuardianTitle(rec.thread_name) || isGuardianTitle(rec.first_user_message)) continue;
				next.set(rec.id, {
					title: rec.thread_name,
					tokens: 0,
					lastActivity: rec.updated_at ? Date.parse(rec.updated_at) : 0,
				});
			} catch (_) { /* partial line */ }
		}
		this.byId = next;
		this.source = 'index';
	}

	lookup(id) { return id ? this.byId.get(id) : undefined; }
}

// One line, first sentence, no markdown — a Codex thread's title is whatever
// the user typed first, newlines and all.
function threadLabel(title) {
	if (!title) return '(untitled)';
	const flat = String(title).replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim();
	const stop = flat.search(/[.?!](\s|$)/);
	const line = stop > 20 ? flat.slice(0, stop + 1) : flat;
	return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function codexUri(conversationId) {
	return vscode.Uri.parse(`${CODEX_SCHEME}://${CODEX_AUTHORITY}/local/${conversationId}`);
}

// The extension's own new-panel command. Its /extension/panel/new route used to
// paint an empty page — the URI parser read uri.fsPath, mangling the route into
// backslashes on Windows (upstream openai/codex#21863) — which is why an earlier
// version of this command detoured through the sidebar and watched ~/.codex for
// the new thread id. With the route bug patched in the installed bundle
// (upstream openai/codex#21863), the route resolves and the panel opens as a normal editor tab, which
// is exactly the Claude behaviour. The tab lands in CHATS via codexTabs() as
// soon as the conversation exists.
const CODEX_EXTENSION_ID = 'openai.chatgpt';

// register() hands over its Output-channel logger so the free-function Codex
// commands can trace the sidebar route they navigate to.
let codexLog = null;

// Codex features are dead weight without the extension that owns the data, so
// name it rather than failing quietly on a missing command or an absent
// ~/.codex.
function requireCodex() {
	if (vscode.extensions.getExtension(CODEX_EXTENSION_ID)) return true;
	vscode.window.showWarningMessage('This needs the Codex (ChatGPT) extension, which is not installed.');
	return false;
}

async function newCodexInTab() {
	if (!requireCodex()) return;
	// createNewPanel picks its own column — the active text editor's, else
	// ViewColumn.Active — so a new agent lands wherever the last file was open
	// rather than beside the chats. Note where it belongs first: the Codex
	// column, else the group right of the Claude column, else wherever the
	// panel opened.
	const codexCol = codexColumn();
	const claudeCol = claudeColumn();
	const targetIndex = codexCol !== null ? codexCol
		: claudeCol !== null ? claudeCol + 1
		: null;
	const before = new Set(codexTabs().map((t) => t.tab));
	await vscode.commands.executeCommand('chatgpt.newCodexPanel');
	if (targetIndex === null) return;

	// The panel is created asynchronously and, since the 26.59 build, can take
	// several seconds to register as a tab. Wait for a Codex tab that was not
	// there before, in any group — it need not be the active one.
	let fresh = null;
	for (let attempt = 0; attempt < 100 && !fresh; attempt++) {
		await new Promise((r) => setTimeout(r, 150));
		fresh = codexTabs().find((t) => !before.has(t.tab)) || null;
	}
	if (!fresh || fresh.groupIndex === targetIndex) return;

	// Activate it where it is, then move it by group distance.
	await vscode.commands.executeCommand('openEditorsTools.focusChat', fresh.groupIndex, fresh.tabIndex);
	const distance = Math.abs(fresh.groupIndex - targetIndex);
	await vscode.commands.executeCommand('moveActiveEditor', {
		to: fresh.groupIndex > targetIndex ? 'left' : 'right',
		by: 'group',
		value: distance,
	});
}

// Which surface a Codex thread opens on: navigate the existing Codex sidebar
// panel, or open a fresh editor tab. Some users keep the Codex chat as the
// sidebar view (placed in the editor area), others run a single conversation
// panel — so the choice is a setting with an auto default. In "auto" the
// sidebar wins whenever a Codex sidebar view is already on screen (codexTabs()
// flags a dragged-out view view:true) OR no Codex conversation editor tab
// exists at all, so a single-panel layout never grows a third surface. With a
// conversation editor tab open and no sidebar view, "auto" keeps opening tabs.
function resolveCodexTarget() {
	const setting = vscode.workspace.getConfiguration('openEditorsTools').get('codexOpenTarget', 'auto');
	if (setting === 'sidebar' || setting === 'editor') return setting;
	const tabs = codexTabs();
	const hasSidebarView = tabs.some((t) => t.view === true);
	const hasConversationEditor = tabs.some((t) => t.view !== true && t.conversationId);
	return (hasSidebarView || !hasConversationEditor) ? 'sidebar' : 'editor';
}

// Load a thread into the existing Codex sidebar panel. The extension registers
// a UriHandler whose handleUri posts navigate-to-route to the sidebar webview,
// so opening vscode://openai.chatgpt/local/<id> routes that panel to the
// thread rather than spawning a tab. chatgpt.openSidebar first reveals the view
// wherever it lives (side bar or editor area); both steps are best-effort, so a
// one-time "Allow … to open this URI" prompt or a missing command cannot
// strand the caller.
async function openCodexInSidebar(conversationId) {
	try { await vscode.commands.executeCommand('chatgpt.openSidebar'); } catch (_) { /* reveal is best-effort */ }
	const route = `vscode://${CODEX_EXTENSION_ID}/local/${conversationId}`;
	if (codexLog) codexLog(`codex sidebar route: ${route}`);
	await vscode.env.openExternal(vscode.Uri.parse(route));
}

// Open a thread as a Codex custom-editor tab in the Codex column — the group
// most Codex conversation tabs already sit in, else one group right of the
// Claude column (ViewColumn is 1-based, so Claude group index N is column
// N + 2), else wherever the host puts it.
async function openCodexInEditor(conversationId) {
	const codexCol = codexColumn();
	const claudeCol = claudeColumn();
	const viewColumn = codexCol !== null
		? vscode.window.tabGroups.all[codexCol].viewColumn
		: claudeCol !== null ? claudeCol + 2
		: undefined;
	await vscode.commands.executeCommand('vscode.openWith', codexUri(conversationId), CODEX_VIEW_TYPE, viewColumn);
}

// "New Codex Agent" honouring the same target choice: in the sidebar a fresh
// chat is chatgpt.newChat once the view is revealed; in an editor tab it is the
// panel path newCodexInTab already drives.
async function newCodexChat() {
	if (!requireCodex()) return;
	if (resolveCodexTarget() === 'sidebar') {
		try { await vscode.commands.executeCommand('chatgpt.openSidebar'); } catch (_) { /* reveal is best-effort */ }
		await vscode.commands.executeCommand('chatgpt.newChat');
		return;
	}
	await newCodexInTab();
}

// The spawn record lives in a JSON blob rather than a column:
//   {"subagent":{"thread_spawn":{"parent_thread_id":"…","agent_nickname":"…"}}}
// with a second shape, {"subagent":{"other":"guardian"}}, for Codex's own
// review passes — those name no parent and are simply not listed.
function subagentSource(source) {
	if (typeof source !== 'string' || source[0] !== '{') return null;
	try {
		const parsed = JSON.parse(source);
		if (!parsed || typeof parsed !== 'object' || !('subagent' in parsed)) return null;
		return parsed.subagent || {};
	} catch (_) { return null; }
}

function parentThreadId(source) {
	const spawn = subagentSource(source);
	return (spawn && spawn.thread_spawn && spawn.thread_spawn.parent_thread_id) || null;
}

// The Codex extension also ships two webview VIEWS (chatgpt.sidebarView and
// chatgpt.sidebarSecondaryView, both titled "Codex"; the title becomes the
// thread name once a chat is open). VS Code lets a view be dragged into the
// editor area, where its tab carries NO recognised input — tab.input is
// undefined — and only the view title survives as the label. Matching that
// label against the thread index is the one way left to recognise such a tab;
// without it an open "POLARITY" view was listed as a closed thread and
// codexColumn() overlooked its group, so openCodexHere's claudeColumn()+2
// fallback kept creating new groups. Set by the ChatsProvider constructor.
let codexIndexForTabs = null;

// A thread id for a view-tab label, null for the "Codex" home view, undefined
// when the label names no Codex thread. Only the Codex index is consulted, so
// a Claude chat sharing the title cannot collide — Claude tabs always carry a
// webview input and never reach this lookup.
function codexViewThreadId(label) {
	const key = String(label || '').trim().toLowerCase();
	if (!key) return undefined;
	if (key === 'codex') return null;
	if (!codexIndexForTabs) return undefined;
	for (const [id, thread] of codexIndexForTabs.byId) {
		if (thread.title && String(thread.title).trim().toLowerCase() === key) return id;
	}
	return undefined;
}

function codexTabs() {
	const out = [];
	const viewTabs = [];
	vscode.window.tabGroups.all.forEach((group, groupIndex) => {
		group.tabs.forEach((tab, tabIndex) => {
			const input = tab.input;
			if (input && input.viewType === CODEX_VIEW_TYPE) {
				// A fresh "New Codex Agent" tab has route /extension/panel/new — no
				// conversation id yet (it gets one server-side once the chat starts,
				// but the tab URI never changes). conversationId stays null for it;
				// the row still belongs in the list, or new agents would be invisible
				// exactly like closed tabs used to be.
				out.push({ tab, groupIndex, tabIndex, conversationId: codexConversationId(input.uri) });
				return;
			}
			// A Codex view dragged into the editor area: no usable input, so the
			// label is the evidence. These are ordinary editor tabs — herding and
			// focus commands treat them like any Codex conversation tab. The
			// guard mirrors _logUnrecognisedTabs: a tab with a viewType OR a uri
			// is an ordinary editor, so a file named after a thread ("notes.md")
			// cannot be claimed as a Codex view.
			if (input && (input.viewType !== undefined || input.uri !== undefined)) return;
			const matched = codexViewThreadId(tab.label);
			if (matched === undefined) return;
			viewTabs.push({ tab, groupIndex, tabIndex, conversationId: matched, view: true });
		});
	});
	// A thread can be on screen twice — its conversation tab plus a dragged-out
	// view, or both sidebar views sharing one title. Each duplicate would get
	// item.id codex:<threadId>, and the tree throws on a repeated id, so only
	// the first appearance of a thread survives. Conversation tabs win: their
	// URI names the thread outright, a view tab only label-matches it.
	const seen = new Set(out.map((t) => t.conversationId).filter(Boolean));
	for (const v of viewTabs) {
		if (v.conversationId && seen.has(v.conversationId)) continue;
		if (v.conversationId) seen.add(v.conversationId);
		out.push(v);
	}
	return out;
}

function claudeTabs() {
	const out = [];
	vscode.window.tabGroups.all.forEach((group, groupIndex) => {
		group.tabs.forEach((tab, tabIndex) => {
			const input = tab.input;
			// VS Code namespaces extension webview view types, so the stored
			// value is "mainThreadWebview-claudeVSCodePanel".
			if (!input || typeof input.viewType !== 'string') return;
			if (!input.viewType.includes('claudeVSCodePanel')) return;
			out.push({ tab, groupIndex, tabIndex });
		});
	});
	return out;
}

// ── Columns ────────────────────────────────────────────────────────────────
// The layout this extension is built for keeps every Claude chat in one editor
// group and every Codex conversation in the group to its right. "The Claude
// column" is wherever most Claude tabs already sit — moving the majority
// toward a single stray would churn the whole layout instead of correcting
// the one tab that drifted.
function columnOf(tabs) {
	if (!tabs.length) return null;
	const counts = new Map();
	for (const t of tabs) counts.set(t.groupIndex, (counts.get(t.groupIndex) || 0) + 1);
	const max = Math.max(...counts.values());
	const tied = [...counts.keys()].filter((g) => counts.get(g) === max).sort((a, b) => a - b);
	if (tied.length === 1) return tied[0];
	// Tie: the group actively showing one of these tabs is the one in use,
	// then the leftmost.
	const groups = vscode.window.tabGroups.all;
	const active = tied.find((g) => tabs.some(
		(t) => t.groupIndex === g && groups[g] && groups[g].activeTab === t.tab));
	return active !== undefined ? active : tied[0];
}

function claudeColumn() { return columnOf(claudeTabs()); }

// Conversation tabs only: the "New Codex Agent" home page has no conversation
// id and says nothing about where conversations live.
function codexColumn() { return columnOf(codexTabs().filter((t) => t.conversationId)); }

// VS Code ships focus-Nth-group commands only up to the fifth; a higher index
// stays unfocused rather than focusing the wrong group.
const FOCUS_GROUP_COMMANDS = [
	'workbench.action.focusFirstEditorGroup',
	'workbench.action.focusSecondEditorGroup',
	'workbench.action.focusThirdEditorGroup',
	'workbench.action.focusFourthEditorGroup',
	'workbench.action.focusFifthEditorGroup',
];

async function focusGroup(index) {
	const cmd = FOCUS_GROUP_COMMANDS[index];
	if (cmd) await vscode.commands.executeCommand(cmd);
}

// There is no API to activate an arbitrary tab, and a webview tab has no URI
// to re-open — so focus the owning group, then jump by index.
async function activateTab(groupIndex, tabIndex) {
	await focusGroup(groupIndex);
	await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', tabIndex);
}

function formatAge(ms) {
	if (!ms) return '';
	const mins = Math.floor((Date.now() - ms) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return days === 1 ? 'yesterday' : `${days}d`;
}

function formatTokens(n) {
	if (!n) return '0';
	if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

// How long the agent has been working on the current turn (live), or how long
// the last one took: your last message to the reply that answered it.
// A turn is not over when the orchestrator ends its message while subagents
// it spawned are still writing — the work is theirs until they stop. So the
// turn runs while any subagent is active, and once settled it ends at the
// later of the reply and the last subagent write.
function turnDuration(data, running, subagents) {
	if (!data || !data.lastUserAt) return null;
	const subs = subagents || { all: [], running: [] };
	const live = running || (subs.running && subs.running.length > 0);
	const lastSubWrite = (subs.all || []).reduce((m, a) => Math.max(m, a.mtimeMs || 0), 0);
	const end = live ? Date.now() : Math.max(data.lastReplyAt || 0, lastSubWrite);
	if (!end || end <= data.lastUserAt) return null;
	const secs = Math.round((end - data.lastUserAt) / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
	return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatCost(usd) {
	if (!usd) return '$0';
	return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd < 100 ? 2 : 0)}`;
}

// Status shows as a file decoration rather than a coloured icon, because the
// row icon is the Claude asterisk — an SVG VS Code renders as-is and will not
// tint. A decoration rides alongside it, so both survive.
const CHAT_SCHEME = 'claude-chat';

const DECORATION = {
	question: {
		badge: '?',
		color: 'charts.orange',
		tooltip: 'Waiting for your answer',
	},
	running: {
		badge: '●',
		color: 'charts.blue',
		tooltip: 'Agent is working',
	},
	unread: {
		badge: '●',
		color: 'charts.green',
		tooltip: 'New reply you have not read',
	},
};

class ChatDecorations {
	constructor() {
		this.states = new Map();
		this._onDidChangeFileDecorations = new vscode.EventEmitter();
		this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
	}

	replace(pairs) {
		const next = new Map();
		for (const [sessionId, state] of pairs) {
			if (sessionId) next.set(sessionId, state);
		}
		// Fire only for rows that actually changed, so an unrelated refresh
		// doesn't repaint the whole tree.
		const changed = [];
		for (const [id, state] of next) {
			if (this.states.get(id) !== state) changed.push(id);
		}
		for (const id of this.states.keys()) {
			if (!next.has(id)) changed.push(id);
		}
		this.states = next;
		if (changed.length) {
			this._onDidChangeFileDecorations.fire(changed.map((id) => uriFor(id)));
		}
	}

	provideFileDecoration(uri) {
		if (uri.scheme !== CHAT_SCHEME) return undefined;
		const spec = DECORATION[this.states.get(uri.path.replace(/^\//, ''))];
		if (!spec) return undefined;
		return {
			badge: spec.badge,
			color: new vscode.ThemeColor(spec.color),
			tooltip: spec.tooltip,
			propagate: false,
		};
	}
}

// What you have already read, per session, surviving reloads and restarts in
// globalState. VS Code exposes no "user looked at this webview" event, so the
// panel infers it: a chat is read while its tab is the active one in the
// active group and the window has focus. Two more things count as reading —
// your own last turn in the transcript (you cannot type a reply to something
// you did not read), and first sight of a session, since a fresh install must
// not light up every chat in the history at once.
const SEEN_KEY = 'openEditorsTools.seen';
const SEEN_MAX = 500;

class SeenStore {
	constructor(memento) {
		this.memento = memento;
		this.map = new Map(Object.entries(memento ? memento.get(SEEN_KEY, {}) : {}));
		this.dirty = false;
	}

	// Called for every session the panel knows about, so an unseen id gets its
	// baseline before it can ever count as unread.
	seed(entry) {
		if (!entry || this.map.has(entry.sessionId)) return;
		this.map.set(entry.sessionId, entry.lastActivity || Date.now());
		this.dirty = true;
	}

	mark(sessionId, when) {
		if (!sessionId) return;
		const at = when || Date.now();
		if ((this.map.get(sessionId) || 0) >= at) return;
		this.map.set(sessionId, at);
		this.dirty = true;
	}

	isUnread(entry) {
		if (!entry || !entry.lastReplyAt) return false;
		const floor = Math.max(this.map.get(entry.sessionId) || 0, entry.lastUserAt || 0);
		return entry.lastReplyAt > floor;
	}

	flush() {
		if (!this.dirty || !this.memento) return;
		this.dirty = false;
		// Newest first, capped — the store would otherwise grow for the life of
		// the install, one entry per session ever opened.
		const kept = [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
		this.map = new Map(kept);
		this.memento.update(SEEN_KEY, Object.fromEntries(kept));
	}
}

function uriFor(sessionId) {
	return vscode.Uri.parse(`${CHAT_SCHEME}:/${sessionId}`);
}

class ChatsProvider {
	constructor(index, extensionUri, decorations, seen) {
		this.index = index;
		this.decorations = decorations;
		this.seen = seen;
		// The Claude asterisk, so a row reads the same as the tab it points at.
		// A codicon would render monochrome and look nothing like OPEN EDITORS.
		this.icon = vscode.Uri.joinPath(extensionUri, 'resources', 'claude.svg');
		this.codexIcon = vscode.Uri.joinPath(extensionUri, 'resources', 'codex.svg');
		this.codex = new CodexIndex();
		// codexTabs() is a free function shared by commands that run outside
		// any provider, so it reaches the thread index through this ref.
		codexIndexForTabs = this.codex;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		// Rendered top-level items, and the tab each one stands for. The tree
		// selection is driven from these — see syncSelection() in register().
		this.items = [];
		this.itemByTab = new Map();
		// Shared spinner frame, advanced by the 200 ms tick (spinnerTick).
		this._spinnerFrame = 0;
		this._spinnerTimer = null;
		// Which parent row the next tick repaints — one per tick, round-robin,
		// so at most five refresh promises per second are ever in flight.
		this._spinnerParentIdx = 0;
		// True from "a root refresh was requested" until the root getChildren
		// returned. Ticks stay silent while it is set: a tick's own refresh is
		// exactly the kind of in-flight work AsyncDataTree makes the root wait
		// for, and enough of them back to back starve it out entirely.
		this._rootPending = false;
		this._rootPendingSince = 0;
		// Labels of tabs the scan could not classify, as last logged — the
		// "unrecognised tabs" diagnostic line fires only when this set changes.
		this._lastUnrecognised = '';
		this.log = null; // register() hands over the Output-channel logger
		this._onDidRender = new vscode.EventEmitter();
		this.onDidRender = this._onDidRender.event;
	}

	refresh() {
		// The one place a root refresh is requested. Marking it before the
		// fire() lets spinnerTick yield until the render lands.
		this._rootPending = true;
		this._rootPendingSince = Date.now();
		this._onDidChangeTreeData.fire();
	}

	// Advance the shared frame and rewrite every child label in place, then
	// repaint ONE parent row. A bare fire() would re-read every transcript
	// five times a second, and firing all parents at once rebuilt the refresh
	// pile-up that froze the tree in 0.13.9 — so the repaint rotates through
	// the parents, and yields entirely while a root refresh is in flight.
	spinnerTick() {
		this._spinnerFrame = (this._spinnerFrame + 1) % SPINNER_FRAMES.length;
		const frame = SPINNER_FRAMES[this._spinnerFrame];
		const parents = [];
		for (const item of this.items) {
			if (!item.subagentItems || !item.subagentItems.length) continue;
			parents.push(item);
			for (const child of item.subagentItems) child.label = `${frame} ${child.baseLabel}`;
		}
		if (this._rootPending && Date.now() - this._rootPendingSince > ROOT_PENDING_MAX_MS) {
			this._rootPending = false;
			if (this.log) this.log('spinner: root refresh watchdog cleared');
		}
		if (this._rootPending || !parents.length) return;
		this._spinnerParentIdx %= parents.length;
		this._onDidChangeTreeData.fire(parents[this._spinnerParentIdx]);
		this._spinnerParentIdx = (this._spinnerParentIdx + 1) % parents.length;
	}

	// Called after every root render: the interval runs only while a child
	// row is on screen, so an idle tree costs nothing.
	updateSpinner() {
		const rows = this.items.filter((it) => it.subagentItems && it.subagentItems.length).length;
		if (rows && !this._spinnerTimer) {
			this._spinnerTimer = setInterval(() => this.spinnerTick(), SPINNER_INTERVAL_MS);
			if (this.log) this.log(`spinner on: ${rows} row(s)`);
		} else if (!rows) {
			this.stopSpinner();
		}
	}

	stopSpinner() {
		if (!this._spinnerTimer) return;
		clearInterval(this._spinnerTimer);
		this._spinnerTimer = null;
		if (this.log) this.log('spinner off');
	}

	getTreeItem(element) { return element; }

	// reveal() walks upward from the target, so children must name their row.
	getParent(element) { return element.parentItem || null; }

	async getChildren(element) {
		// Child level: the running subagents attached to a chat row.
		if (element) return element.subagentItems || [];

		// Root render underway: a spinner tick that fired now would hand
		// AsyncDataTree another child refresh to wait on, so ticks go silent
		// until this pass returns. Set here as well as in refresh(), because
		// VS Code also calls the root getChildren on its own — view reveal,
		// collapse-state changes — with no fire() beforehand.
		this._rootPending = true;
		this._rootPendingSince = Date.now();

		const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
		await this.index.refresh(folder ? folder.uri.fsPath : null);

		this.codex.refresh();
		const live = liveSessionIds();

		const projectDir = folder && projectDirFor(folder.uri.fsPath);
		// Titled rows claim their transcript first, so an untitled tab cannot
		// steal one that already belongs to a named chat.
		const claimed = new Set();
		for (const t of claudeTabs()) {
			const hit = this.index.lookup(t.tab.label);
			if (hit) claimed.add(hit.sessionId);
		}
		const untitledCutoff = Date.now() - 3600000;

		// The one chat you are actually looking at right now, if any.
		const activeGroup = vscode.window.tabGroups.all.find((g) => g.isActive);
		const activeTab = vscode.window.state.focused && activeGroup ? activeGroup.activeTab : null;

		const rows = claudeTabs().map((t) => {
			const data = this.index.lookup(t.tab.label)
				|| this.index.unclaimedSince(untitledCutoff, claimed, live);
			this.seen.seed(data);
			if (data && t.tab === activeTab) this.seen.mark(data.sessionId);
			const state = stateOf(data, data && live.has(data.sessionId), this.seen);
			// Every chat gets the subagent scan, not just running ones: their
			// tokens count towards the chat's total whether or not they are
			// still working. Summaries are cached by mtime+size, so a settled
			// session costs one readdir.
			const subagents = (projectDir && data)
				? subagentsFor(projectDir, data.sessionId)
				: { all: [], running: [], cost: 0, messages: 0 };
			return { ...t, kind: 'claude', data, state, subagents, subs: subagents.running };
		});
		this.hasRunningSubagents = rows.some((r) => r.subs && r.subs.length);
		// Codex rows are appended below, so re-check after they land.
		this.decorations.replace(rows.map((r) => [r.data && r.data.sessionId, r.state]));
		this.seen.flush();

		// Codex threads carry no pending-tool or liveness signal, so they never
		// take a status dot — only Claude rows do.
		for (const t of codexTabs()) {
			const subs = t.conversationId
				? this.codex.subagentsFor(t.conversationId, Date.now() - SUBAGENT_ACTIVE_MS)
				: [];
			rows.push({ ...t, kind: 'codex', data: this.codex.lookup(t.conversationId), subs });
		}

		this.hasRunningSubagents = this.hasRunningSubagents || rows.some((r) => (r.kind === 'codex' || r.kind === 'codex-live') && r.subs && r.subs.length);

		// Chats whose tab was closed. The list above mirrors open tabs, so
		// closing a tab used to silently drop the chat from the panel even
		// though its session lives on in the transcripts. These rows come from
		// the transcript index instead, and clicking one reopens the session —
		// claude-vscode.editor.open takes a session id (the panel registry is
		// keyed on it), which is how the extension's own sessions list opens
		// them.
		const hours = vscode.workspace.getConfiguration('openEditorsTools').get('closedChatHours', 48);
		if (hours > 0) {
			const cutoff = Date.now() - hours * 3600000;
			const openTitles = new Set(rows.filter((r) => r.kind === 'claude').map((r) => r.tab.label.trim().toLowerCase()));
			const newestByTitle = new Map();
			for (const entry of this.index.byFile.values()) {
				if (!entry.title || entry.lastActivity < cutoff) continue;
				// A transcript claimed by an open tab is not a closed chat, even
				// when its stored title differs from the tab label — the rename
				// case produced a phantom closed row of the chat's old name.
				if (claimed.has(entry.sessionId)) continue;
				const key = entry.title.trim().toLowerCase();
				if (openTitles.has(key)) continue;
				const seen = newestByTitle.get(key);
				if (!seen || entry.lastActivity > seen.lastActivity) newestByTitle.set(key, entry);
			}
			for (const entry of newestByTitle.values()) {
				// Seeded but never marked unread: you closed the tab, so a dot on
				// a closed row would be noise rather than news.
				this.seen.seed(entry);
				rows.push({ kind: 'claude-closed', data: entry });
			}
			const openCodexIds = new Set(rows.filter((r) => r.kind === 'codex').map((r) => r.conversationId));
			const liveSince = Date.now() - CODEX_LIVE_MS;
			for (const [id, thread] of this.codex.byId) {
				if (thread.archived || !thread.title || thread.lastActivity < cutoff) continue;
				if (openCodexIds.has(id)) continue;
				if (thread.lastActivity >= liveSince) {
					const subs = this.codex.subagentsFor(id, Date.now() - SUBAGENT_ACTIVE_MS);
					rows.push({ kind: 'codex-live', conversationId: id, data: thread, subs });
					continue;
				}
				rows.push({ kind: 'codex-closed', conversationId: id, data: thread });
			}
		}

		// Most recent activity first. Tabs we cannot match (a brand new chat with
		// no transcript yet) sort last rather than jumping to the top.
		// Only a Claude chat with no tab is provably closed, and those sink to a
		// bottom block. A Codex chat cannot be classified: it can run in Codex's
		// sidebar with no editor tab and idle for hours between local writes, so
		// "no tab, 13h old" says nothing about whether it is closed. Sorting it
		// with the open rows by recency put a same-morning Codex chat above 18
		// older Claude tabs instead of dead last. Codex rows therefore never take
		// the closed penalty; they sort purely on the newest of their three
		// activity signals.
		const openRank = (row) => (row.kind === 'claude-closed' ? 1 : 0);
		rows.sort((a, b) =>
			openRank(a) - openRank(b)
			|| (b.data ? b.data.lastActivity : 0) - (a.data ? a.data.lastActivity : 0));

		// Usage lives in its own webview above this tree — see usageView.js.
		const items = rows.map((row) => {
			const item = row.kind === 'codex' ? this._codexItem(row)
				: row.kind === 'codex-live' ? this._codexLiveItem(row)
				: row.kind === 'claude-closed' ? this._closedClaudeItem(row.data)
				: row.kind === 'codex-closed' ? this._closedCodexItem(row)
				: this._item(row);
			item.expandable = Boolean(item.subagentItems && item.subagentItems.length);
			return { item, tab: row.tab };
		});
		this.items = items.map((x) => x.item);
		this.itemByTab = new Map(items.filter((x) => x.tab).map((x) => [x.tab, x.item]));
		this._logUnrecognisedTabs();
		this._onDidRender.fire();
		this._rootPending = false;
		this.updateSpinner();
		return this.items;
	}

	// Diagnostic trail for tabs the scan cannot classify — a webview view
	// dragged into the editor area arrives with tab.input undefined, and one
	// such tab hid an open Codex thread behind a "closed" row. Logged only
	// when the set changes, so the channel stays readable.
	_logUnrecognisedTabs() {
		const labels = [];
		vscode.window.tabGroups.all.forEach((group) => {
			group.tabs.forEach((tab) => {
				const input = tab.input;
				// An input with a viewType or a uri is an ordinary editor the
				// scan already understands or skips on purpose.
				if (input && (input.viewType !== undefined || input.uri !== undefined)) return;
				if (codexViewThreadId(tab.label) !== undefined) return;
				labels.push(tab.label);
			});
		});
		const key = labels.join(' | ');
		if (key === this._lastUnrecognised) return;
		this._lastUnrecognised = key;
		if (key && this.log) this.log(`unrecognised tabs: ${key}`);
	}

	_closedClaudeItem(data) {
		const item = new vscode.TreeItem(data.title, vscode.TreeItemCollapsibleState.None);
		item.id = `closed:${data.sessionId}`;
		// Codicon, not the logo — closed rows should read as a different class
		// of thing at a glance.
		item.iconPath = new vscode.ThemeIcon('history');
		item.contextValue = 'closedClaudeChat';
		item.description = [formatAge(data.lastActivity), 'closed', formatCost(data.cost)].join(' · ');
		item.tooltip = `${data.title} — closed. Click to reopen this session in a tab.`;
		item.command = {
			command: 'openEditorsTools.reopenClaudeSession',
			title: 'Reopen session',
			arguments: [data.sessionId],
		};
		return item;
	}

	// Running in Codex's sidebar: no tab to focus, so a click opens the thread
	// as a tab beside the Claude chat instead.
	_codexLiveItem(row) {
		const { data, conversationId, subs } = row;
		const item = new vscode.TreeItem(data.title, subs && subs.length
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None);
		item.id = `codex-live:${conversationId}`;
		// The context-menu commands reach the thread through this, whichever
		// command the row's default click carries.
		item.conversationId = conversationId;
		item.iconPath = this.codexIcon;
		item.contextValue = 'codexChat';
		item.command = {
			command: 'openEditorsTools.openCodexHere',
			title: 'Open thread',
			arguments: [conversationId],
		};
		if (subs && subs.length) {
			item.subagentItems = subs.map((sub) => {
				const child = new vscode.TreeItem(`${SPINNER_FRAMES[this._spinnerFrame]} ${sub.name}`, vscode.TreeItemCollapsibleState.None);
				// spinnerTick rebuilds the label from this between renders.
				child.baseLabel = sub.name;
				child.id = `${item.id}:agent:${sub.id}`;
				child.parentItem = item;
				child.contextValue = 'subagent';
				child.description = [sub.model, sub.tokens ? `${formatTokens(sub.tokens)} tok` : null, formatAge(sub.lastActivity)].filter(Boolean).join(' · ');
				return child;
			});
		}
		item.description = [
			subs && subs.length ? `${subs.length} agent${subs.length > 1 ? 's' : ''}` : null,
			formatAge(data.lastActivity),
			data.tokens ? `${formatTokens(data.tokens)} tok` : null,
			data.model,
			'sidebar',
		].filter(Boolean).join(' · ');
		item.tooltip = `${data.title} — running in the Codex sidebar. Click to open it.`;
		return item;
	}

	_closedCodexItem(row) {
		const item = new vscode.TreeItem(row.data.title, vscode.TreeItemCollapsibleState.None);
		item.id = `codex-closed:${row.conversationId}`;
		item.conversationId = row.conversationId;
		// The Codex logo, not the history codicon — a row should say which
		// agent it is before it says how old it is.
		item.iconPath = this.codexIcon;
		item.contextValue = 'closedCodexChat';
		item.description = [formatAge(row.data.lastActivity), 'closed', row.data.model].filter(Boolean).join(' · ');
		item.tooltip = `${row.data.title} — closed Codex thread. Click to open it.`;
		item.command = {
			command: 'openEditorsTools.openCodexHere',
			title: 'Open thread',
			arguments: [row.conversationId],
		};
		return item;
	}

	_codexItem(row) {
		const { tab, groupIndex, tabIndex, data, conversationId, subs } = row;
		const item = new vscode.TreeItem(tab.label, subs && subs.length
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None);
		// Identity is the thread, or the tab's position for an agent that has no
		// thread yet — never the label, which two chats can share.
		item.id = `codex:${conversationId || `new:${groupIndex}:${tabIndex}`}`;
		// null for a brand-new agent with no thread yet; the sidebar/editor
		// context commands no-op on that until the conversation exists.
		item.conversationId = conversationId;
		item.iconPath = this.codexIcon;
		item.contextValue = 'codexChat';
		item.command = {
			command: 'openEditorsTools.focusChat',
			title: 'Focus chat',
			arguments: [groupIndex, tabIndex],
		};

		if (!conversationId) {
			// /extension/panel/new — a just-opened agent with no thread yet.
			item.description = 'new agent';
			item.tooltip = 'Fresh Codex agent — appears with metadata once the conversation is underway.';
			return item;
		}
		if (!data) {
			item.description = 'no thread record';
			item.tooltip = `Codex conversation ${conversationId} is not in ~/.codex.`;
			return item;
		}

		if (subs && subs.length) {
			item.subagentItems = subs.map((sub) => {
				const child = new vscode.TreeItem(`${SPINNER_FRAMES[this._spinnerFrame]} ${sub.name}`, vscode.TreeItemCollapsibleState.None);
				child.baseLabel = sub.name;
				child.id = `${item.id}:agent:${sub.id}`;
				child.parentItem = item;
				child.contextValue = 'subagent';
				child.description = [
					sub.model,
					sub.tokens ? `${formatTokens(sub.tokens)} tok` : null,
					formatAge(sub.lastActivity),
				].filter(Boolean).join(' · ');
				child.tooltip = `${sub.name} — Codex subagent of this thread. The row disappears once its thread is idle for 2 minutes.`;
				return child;
			});
		}

		// No cost column: these are OpenAI models and this extension has no
		// verified price list for them. A made-up rate would be worse than none.
		// And no turn duration either — Codex transcripts expose no
		// user-message timestamp to measure from.
		item.description = [
			subs && subs.length ? `${subs.length} agent${subs.length > 1 ? 's' : ''}` : null,
			formatAge(data.lastActivity),
			data.tokens ? `${formatTokens(data.tokens)} tok` : null,
			data.model,
		].filter(Boolean).join(' · ');

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${tab.label}**\n\n`);
		md.appendMarkdown(`| | |\n|---|---|\n`);
		md.appendMarkdown(`| Agent | Codex |\n`);
		if (data.model) md.appendMarkdown(`| Model | \`${data.model}\` |\n`);
		if (data.effort) md.appendMarkdown(`| Effort | ${data.effort} |\n`);
		md.appendMarkdown(`| Last activity | ${formatAge(data.lastActivity)} |\n`);
		if (data.tokens) md.appendMarkdown(`| Tokens used | ${data.tokens.toLocaleString()} |\n`);
		md.appendMarkdown(`| Thread | \`${conversationId}\` |\n\n`);
		md.appendMarkdown(`_Read from \`${this.codex.source === 'sqlite' ? `~/.codex/${this.codex.sourceFile || 'state_N.sqlite'}` : '~/.codex/session_index.jsonl'}\`. No cost shown — no verified price list for these models._`);
		item.tooltip = md;
		return item;
	}

	_item(row) {
		const { tab, groupIndex, tabIndex, data, state, subs } = row;
		// Expanded while subagents run; back to a flat row when they finish, so
		// the list stays compact.
		const collapse = subs && subs.length
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(tab.label, collapse);
		// A stable id is what keeps the tree's selection pinned to a chat. Without
		// one VS Code identifies a row by its position, and this list re-sorts on
		// every refresh — so the highlight stayed on slot 4 while the chat that
		// had been there moved, and it ended up marking a chat nobody opened.
		item.id = `chat:${data ? data.sessionId : `${groupIndex}:${tabIndex}`}`;
		if (subs && subs.length) {
			item.subagentItems = subs.map((sub) => {
				const name = sub.name || `agent ${sub.id.slice(0, 8)}`;
				const child = new vscode.TreeItem(`${SPINNER_FRAMES[this._spinnerFrame]} ${name}`, vscode.TreeItemCollapsibleState.None);
				child.baseLabel = name;
				child.contextValue = 'subagent';
				// Same shape as a Codex child row — model · total tokens · age —
				// plus cost, which stays because Claude models have a price list.
				// The in/out/cache split moved to the tooltip.
				const rowModel = sub.model || sub.metaModel;
				const rowTokens = sub.totals.input + sub.totals.cacheRead
					+ sub.totals.write5m + sub.totals.write1h + sub.totals.output;
				child.description = [
					rowModel ? rowModel.replace(/^claude-/, '') : null,
					rowTokens ? `${formatTokens(rowTokens)} tok` : null,
					formatAge(sub.mtimeMs),
					sub.cost ? formatCost(sub.cost) : null,
				].filter(Boolean).join(' · ');
				const md = new vscode.MarkdownString();
				md.appendMarkdown(`**${sub.name || 'subagent'}**\n\n`);
				md.appendMarkdown(`| | |\n|---|---|\n`);
				if (sub.kind) md.appendMarkdown(`| Kind | ${sub.kind} |\n`);
				if (sub.phase) md.appendMarkdown(`| Phase | ${sub.phase} |\n`);
				md.appendMarkdown(`| Model | \`${sub.model || sub.metaModel || 'unknown'}\` |\n`);
				md.appendMarkdown(`| Turns | ${sub.messages} |\n`);
				md.appendMarkdown(`| Input | ${sub.totals.input.toLocaleString()} |\n`);
				md.appendMarkdown(`| Output | ${sub.totals.output.toLocaleString()} |\n`);
				md.appendMarkdown(`| Cache read | ${sub.totals.cacheRead.toLocaleString()} |\n`);
				md.appendMarkdown(`| Cost | **${formatCost(sub.cost)}** |\n`);
				md.appendMarkdown(`| Last write | ${formatAge(sub.mtimeMs)} |\n\n`);
				md.appendMarkdown(`_The row disappears once this transcript is idle for 2 minutes._`);
				child.tooltip = md;
				child.id = `${item.id}:agent:${sub.id}`;
				child.parentItem = item;
				return child;
			});
		}
		item.iconPath = this.icon;
		item.contextValue = 'claudeChat';
		// Carries the status decoration; nothing on disk is behind this URI.
		if (data && data.sessionId) item.resourceUri = uriFor(data.sessionId);
		item.command = {
			command: 'openEditorsTools.focusChat',
			title: 'Focus chat',
			arguments: [groupIndex, tabIndex],
		};

		if (!data) {
			item.description = tab.isDirty ? 'working…' : 'no transcript yet';
			item.tooltip = 'No session transcript matched this tab title yet.';
			return item;
		}

		const pct = data.contextLimit ? Math.round((data.contextTokens / data.contextLimit) * 100) : 0;
		const subagents = row.subagents || { all: [], cost: 0, messages: 0 };
		const totalCost = data.cost + subagents.cost;
		const worked = turnDuration(data, state === 'running', subagents);
		const live = state === 'running' || (subs && subs.length > 0);
		item.description = [
			subs && subs.length ? `${subs.length} agent${subs.length > 1 ? 's' : ''}` : null,
			worked ? (live ? `⏱ ${worked}` : `${worked} turn`) : formatAge(data.lastActivity),
			`${formatTokens(data.contextTokens)}/${formatTokens(data.contextLimit)}`,
			formatCost(totalCost),
		].filter(Boolean).join(' · ');

		const billed = data.totals.input + data.totals.output + data.totals.cacheRead
			+ data.totals.write5m + data.totals.write1h;
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${tab.label}**\n\n`);
		md.appendMarkdown(`| | |\n|---|---|\n`);
		md.appendMarkdown(`| Status | ${(DECORATION[state] && DECORATION[state].tooltip) || 'Idle'}${data.pendingTools.length ? ` (${data.pendingTools.join(', ')})` : ''} |\n`);
		md.appendMarkdown(`| Model | \`${data.model || 'unknown'}\` |\n`);
		md.appendMarkdown(`| Last activity | ${formatAge(data.lastActivity)} |\n`);
		md.appendMarkdown(`| Context in play | ${data.contextTokens.toLocaleString()} / ${data.contextLimit.toLocaleString()} (${pct}%) |\n`);
		md.appendMarkdown(`| Assistant turns | ${data.messages.toLocaleString()} |\n`);
		md.appendMarkdown(`| Input | ${data.totals.input.toLocaleString()} |\n`);
		md.appendMarkdown(`| Output | ${data.totals.output.toLocaleString()} |\n`);
		md.appendMarkdown(`| Cache read | ${data.totals.cacheRead.toLocaleString()} |\n`);
		md.appendMarkdown(`| Cache write 5m | ${data.totals.write5m.toLocaleString()} |\n`);
		md.appendMarkdown(`| Cache write 1h | ${data.totals.write1h.toLocaleString()} |\n`);
		md.appendMarkdown(`| Tokens billed | ${billed.toLocaleString()} |\n`);
		md.appendMarkdown(`| This chat | ${formatCost(data.cost)} |\n`);
		if (subagents.all.length) {
			md.appendMarkdown(`| Subagents (${subagents.all.length}, ${subagents.messages} turns) | ${formatCost(subagents.cost)} |\n`);
		}
		md.appendMarkdown(`| API-equivalent cost | **${formatCost(totalCost)}** |\n\n`);
		md.appendMarkdown(`_Cost is what these tokens would bill at list API rates — cache reads at 0.1x input, writes at 1.25x (5m) / 2x (1h). A Claude subscription is not billed this way._`);
		item.tooltip = md;
		return item;
	}
}

async function arrangeLeft() {
	await vscode.commands.executeCommand('workbench.action.positionPanelLeft');
	await vscode.commands.executeCommand('workbench.view.extension.openEditorsToolsChats');
}

// Once per install: without this the container sat in a collapsed panel and
// the user had to know to look for it. Later reloads leave the layout alone —
// it is theirs to change from then on.
const FIRST_RUN_KEY = 'openEditorsTools.firstRunDone';
async function firstRun(context) {
	if (context.globalState.get(FIRST_RUN_KEY)) return;
	await context.globalState.update(FIRST_RUN_KEY, true);
	try { await arrangeLeft(); } catch (_) { /* layout commands are best effort */ }
}

// VS Code remembers where a user dragged each view. Someone who once moved
// Chats and Usage into another container (the Terminal panel, in the case that
// prompted this) keeps them there, while a view added by a later release is
// born in the home container — so the three never share a panel again without
// manual dragging. vscode.moveViews puts them back together; a view already
// home is left alone.
const HOME_CONTAINER = 'workbench.view.extension.openEditorsToolsChats';
const OWN_VIEWS = ['openEditorsTools.chats', 'openEditorsTools.usage', 'openEditorsTools.leaderboard'];
async function gatherViews() {
	await vscode.commands.executeCommand('vscode.moveViews', { viewIds: OWN_VIEWS, destinationId: HOME_CONTAINER });
	await arrangeLeft();
}

// Once per install, on the release that introduced the third view: without it
// the Leaderboard sat alone in a hidden container for anyone with moved views.
const GATHERED_KEY = 'openEditorsTools.viewsGathered.v1';
async function gatherOnce(context) {
	if (context.globalState.get(GATHERED_KEY)) return;
	await context.globalState.update(GATHERED_KEY, true);
	try { await gatherViews(); } catch (_) { /* layout commands are best effort */ }
}

function register(context) {
	firstRun(context);
	gatherOnce(context);
	const index = new TranscriptIndex();
	// One channel for everything this extension does that can fail quietly:
	// usage fetches, webview resolution, layout moves. Opened from
	// "Agent View: Show Log".
	const output = vscode.window.createOutputChannel('Agent View');
	const log = (message) => output.appendLine(`${new Date().toISOString().slice(11, 19)}  ${message}`);
	// Let the free-function Codex commands trace the sidebar route they open.
	codexLog = log;
	log(`activated on ${process.platform}, remote=${vscode.env.remoteName || 'local'}`);

	if (context.globalState.get('openEditorsTools.restyle')) {
		try { restyle.apply().forEach((r) => log(`restyle: ${r.status} — ${r.cssFile}`)); } catch (err) { log(`restyle failed: ${err.message}`); }
	}

	const decorations = new ChatDecorations();
	const seen = new SeenStore(context.globalState);
	const provider = new ChatsProvider(index, context.extensionUri, decorations, seen);
	provider.log = log;
	// One cache feeds the bars; it repaints them itself whenever a lookup lands.
	const usage = new UsageCache(() => { usageView.render(); if (!usageView.isVisible()) leaderboardView.render(); }, log);
	const usageView = new UsageViewProvider(usage, log);
	// Re-read the exclude list on every write so a settings change lands on the
	// next refresh; leaderboard.js stays vscode-free, so the getter lives here.
	const leaderboard = new LeaderboardCache(context, () => leaderboardView.render(), log, {
		getExcluded: () => vscode.workspace.getConfiguration('openEditorsTools').get('subagentExcludeModels', DEFAULT_SUBAGENT_EXCLUDE),
	});
	const leaderboardView = new LeaderboardViewProvider(leaderboard, log);
	// While the Usage pane is collapsed or hidden its bars ride on top of the
	// Leaderboard pane — see LeaderboardViewProvider.usageBlock.
	leaderboardView.usageBlock = () => (usageView.isVisible() ? null : usageView.block());
	usageView.onVisibilityChange = () => leaderboardView.render();
	leaderboard.start();

	// A real TreeView rather than registerTreeDataProvider, because the panel has
	// to drive its own selection: the grey highlight is the tree's selection, and
	// VS Code never moves it when you switch tabs by any other route — clicking
	// the tab itself, a keyboard shortcut, a new chat opening. It then read as a
	// claim about which chat was open while pointing at a different one.
	const view = vscode.window.createTreeView('openEditorsTools.chats', {
		treeDataProvider: provider,
		showCollapseAll: false,
	});

	// Point the selection at the chat that is actually open. Selection is not
	// moved for a non-chat tab: the last chat stays marked, which is still the
	// truth about which chat is in play.
	let lastRevealed = null;
	const syncSelection = () => {
		const group = vscode.window.tabGroups.all.find((g) => g.isActive);
		const active = group && group.activeTab;
		const item = active && provider.itemByTab.get(active);
		if (!item) return;
		// Expanding here rather than through a changing item id: an id that moves
		// with the running-subagent count would reintroduce the drift this whole
		// mechanism exists to fix.
		const expand = item.expandable || undefined;
		if (lastRevealed === item.id && !expand) return;
		lastRevealed = item.id;
		// focus stays where the user put it — revealing must never steal the
		// caret out of a chat's input box.
		Promise.resolve(view.reveal(item, { select: true, focus: false, expand }))
			.then(undefined, () => { lastRevealed = null; });
	};
	provider.onDidRender(syncSelection);

	// Debounced: an active session rewrites its transcript on every message,
	// and fs.watch fires several times per write.
	let pending = null;
	const scheduleRefresh = () => {
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => { pending = null; provider.refresh(); }, 1500);
	};

	const watchers = [];
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	const dir = folder && projectDirFor(folder.uri.fsPath);
	// Transcripts drive age/cost/pending-tool state; the sessions directory
	// drives liveness, and a chat going away writes only there.
	// ~/.codex itself churns constantly (log database writes), so watch only the
	// thread index file, and let tab changes cover the rest.
	// The project dir is watched recursively (supported on Windows and macOS):
	// subagent transcripts live two levels down in <session>/subagents/, and
	// their writes are what drive the running-agent child rows.
	for (const [target, options] of [
		[dir, { recursive: true }],
		[path.join(claudeConfigDir(), 'sessions'), undefined],
		[path.join(codexDir(), 'session_index.jsonl'), undefined],
	]) {
		if (!target) continue;
		try {
			watchers.push(options ? fs.watch(target, options, scheduleRefresh) : fs.watch(target, scheduleRefresh));
		} catch (_) { /* still readable, just no live refresh */ }
	}

	// A finished subagent stops writing, which means no event ever fires to
	// clear its spinner — sweep on a timer, but only while spinners are up.
	const sweep = setInterval(() => {
		if (provider.hasRunningSubagents) provider.refresh();
	}, 45000);

	// The usage bars need a heartbeat of their own. UsageCache.get() is what
	// notices a stale entry and refetches, and only render() calls it — but
	// render() only runs when a fetch lands. After the first pair settled,
	// nothing ever asked again and the bars sat unchanged for days. Ticking
	// well under the 5-minute TTL keeps them honest; get() is a Map lookup
	// unless the entry has actually expired.
	const usageTick = setInterval(() => { usageView.render(); if (!usageView.isVisible()) leaderboardView.render(); }, 60000);

	// A refreshed token is the one thing that fixes an expired-token panel, and
	// it arrives as a file write rather than anything we could poll cheaply.
	let credentialsDebounce = null;
	const onCredentials = () => {
		if (credentialsDebounce) clearTimeout(credentialsDebounce);
		credentialsDebounce = setTimeout(() => {
			credentialsDebounce = null;
			log('credentials changed, refetching Claude usage');
			usage.invalidate('claude');
			usageView.render();
		}, 1000);
	};

	context.subscriptions.push(
		output,
		watchCredentials(onCredentials),
		{ dispose: () => credentialsDebounce && clearTimeout(credentialsDebounce) },
		view,
		vscode.window.registerWebviewViewProvider('openEditorsTools.usage', usageView, {
			// Cheap to keep alive, and it avoids a blank flash every time the
			// container is revealed.
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerWebviewViewProvider('openEditorsTools.leaderboard', leaderboardView, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerFileDecorationProvider(decorations),
		// "New Codex Agent" opens the panel at route /extension/panel, and the
		// webview's router reports location "/" with no component — an empty
		// page. A conversation URI carries its own route, so opening one
		// directly is the test of whether the editor host works at all.
		// The row's default click. Where the thread lands follows the
		// codexOpenTarget setting: the sidebar path navigates the existing Codex
		// panel, the editor path opens a tab in the Codex column (created on
		// demand right of Claude, so Claude and Codex keep separate columns).
		vscode.commands.registerCommand('openEditorsTools.openCodexHere', async (conversationId) => {
			if (resolveCodexTarget() === 'sidebar') { await openCodexInSidebar(conversationId); return; }
			await openCodexInEditor(conversationId);
		}),
		// Two explicit row commands so either surface is one right-click away
		// regardless of the setting. Both take the tree item and read its
		// conversationId; a new-agent row carries null and is skipped.
		vscode.commands.registerCommand('openEditorsTools.openCodexInSidebar', async (item) => {
			if (!requireCodex()) return;
			const id = item && item.conversationId;
			if (id) await openCodexInSidebar(id);
		}),
		vscode.commands.registerCommand('openEditorsTools.openCodexInEditor', async (item) => {
			if (!requireCodex()) return;
			const id = item && item.conversationId;
			if (id) await openCodexInEditor(id);
		}),
		// Registered here rather than in extension.js as a plain forward:
		// claude-vscode.editor.open opens in the ACTIVE group, which is how new
		// chats drifted into the file or Codex group. Focus the Claude column
		// first, then open. No arguments on purpose — an argument would be
		// taken as a session id.
		vscode.commands.registerCommand('openEditorsTools.newClaudeChat', async () => {
			if (!vscode.extensions.getExtension('Anthropic.claude-code')) {
				vscode.window.showWarningMessage('This needs the Claude Code extension, which is not installed.');
				return;
			}
			const column = claudeColumn();
			if (column !== null) await focusGroup(column);
			try {
				await vscode.commands.executeCommand('claude-vscode.editor.open');
			} catch (err) {
				vscode.window.showErrorMessage(`Could not open a new Claude chat — ${err.message}`);
			}
		}),
		vscode.commands.registerCommand('openEditorsTools.openCodexThread', async () => {
			if (!requireCodex()) return;
			const index = new CodexIndex();
			index.refresh();
			// Codex threads rarely carry a `name`; `title` falls back to the first
			// user message, which is a paragraph. Trim it to one readable line and
			// keep the id out of the label — it belongs in the detail row.
			const items = [...index.byId.entries()]
				.filter(([, t]) => !t.archived)
				.sort((a, b) => b[1].lastActivity - a[1].lastActivity)
				.slice(0, 40)
				.map(([id, t]) => ({
					label: threadLabel(t.title),
					description: `${formatAge(t.lastActivity)}${t.model ? ` · ${t.model}` : ''}`,
					detail: id,
					id,
				}));
			if (!items.length) {
				vscode.window.showWarningMessage(`No Codex threads found (source: ${index.source}).`);
				return;
			}
			const picked = await vscode.window.showQuickPick(items, {
				title: 'Open Codex conversation in an editor tab',
				matchOnDetail: true,
			});
			if (!picked) return;
			const uri = codexUri(picked.id);
			try {
				await vscode.commands.executeCommand('openEditorsTools.openCodexHere', picked.id);
			} catch (err) {
				vscode.window.showErrorMessage(`Could not open ${uri.toString()} — ${err.message}`);
			}
		}),
		vscode.commands.registerCommand('openEditorsTools.newCodexChat', newCodexChat),
		// The counterpart to the Codex thread picker: Claude sessions are only
		// reachable from the tree while they are inside the closed-chat window,
		// so this reaches the whole transcript history.
		vscode.commands.registerCommand('openEditorsTools.openClaudeSession', async () => {
			const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
			await index.refresh(folder ? folder.uri.fsPath : null);
			const items = [...index.byFile.values()]
				.filter((entry) => entry.title && entry.sessionId)
				.sort((a, b) => b.lastActivity - a.lastActivity)
				.slice(0, 60)
				.map((entry) => ({
					label: entry.title,
					description: [formatAge(entry.lastActivity), entry.model && entry.model.replace(/^claude-/, ''), formatCost(entry.cost)]
						.filter(Boolean).join(' · '),
					detail: entry.sessionId,
					sessionId: entry.sessionId,
				}));
			if (!items.length) {
				vscode.window.showWarningMessage('No Claude session transcripts found for this workspace.');
				return;
			}
			const picked = await vscode.window.showQuickPick(items, {
				title: 'Open Claude session in an editor tab',
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (picked) await vscode.commands.executeCommand('openEditorsTools.reopenClaudeSession', picked.sessionId);
		}),
		vscode.commands.registerCommand('openEditorsTools.reopenClaudeSession', async (sessionId) => {
			try {
				await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
			} catch (err) {
				vscode.window.showErrorMessage(`Could not reopen session ${sessionId} — ${err.message}`);
			}
		}),
		// One palette entry that always brings the panel back, wherever the user
		// dragged the container: VS Code registers workbench.view.extension.<id>
		// for every contributed container, and it opens the container in place.
		vscode.commands.registerCommand('openEditorsTools.showLog', () => output.show(true)),
		// One line per open tab, into the same channel: what the input object
		// is, and whether the scan recognised it. This is the tool for "a chat
		// is open but the panel lists it as closed" — a dragged-out webview
		// view shows up here as input=none with recognised=codex-view or '-'.
		vscode.commands.registerCommand('openEditorsTools.dumpTabs', () => {
			vscode.window.tabGroups.all.forEach((group, i) => {
				group.tabs.forEach((tab, j) => {
					const input = tab.input;
					const recognised = input && typeof input.viewType === 'string' && input.viewType.includes('claudeVSCodePanel') ? 'claude'
						: input && input.viewType === CODEX_VIEW_TYPE ? 'codex'
						: (!input || input.viewType === undefined) && codexViewThreadId(tab.label) !== undefined ? 'codex-view'
						: '-';
					log(`group ${i} tab ${j} label=${tab.label}`
						+ ` input=${input ? (input.constructor && input.constructor.name) || 'object' : 'none'}`
						+ ` viewType=${(input && input.viewType) || '-'}`
						+ ` uri=${input && input.uri ? input.uri.toString() : '-'}`
						+ ` recognised=${recognised} active=${tab.isActive === true}`);
				});
			});
			output.show(true);
		}),
		// Opt-in, sticky: once turned on it survives Claude Code updates, which
		// install a fresh directory and silently shed the override.
		vscode.commands.registerCommand('openEditorsTools.restyleOn', async () => {
			const results = restyle.apply();
			await context.globalState.update('openEditorsTools.restyle', true);
			results.forEach((r) => log(`restyle: ${r.status} — ${r.cssFile}`));
			vscode.window.showInformationMessage('Claude panel restyled. Reload the window to see it.');
		}),
		vscode.commands.registerCommand('openEditorsTools.restyleOff', async () => {
			const results = restyle.revert();
			await context.globalState.update('openEditorsTools.restyle', false);
			results.forEach((r) => log(`restyle: ${r.status} — ${r.cssFile}`));
			vscode.window.showInformationMessage('Claude panel restored to stock. Reload the window.');
		}),
		vscode.commands.registerCommand('openEditorsTools.showChats', () =>
			vscode.commands.executeCommand('workbench.view.extension.openEditorsToolsChats')),
		vscode.commands.registerCommand('openEditorsTools.showLeaderboard', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.openEditorsToolsChats');
			await vscode.commands.executeCommand('openEditorsTools.leaderboard.focus');
		}),
		vscode.commands.registerCommand('openEditorsTools.setAslApiKey', async () => {
			const key = await vscode.window.showInputBox({
				title: 'AI Stupid Level API key',
				prompt: 'Stored in VS Code SecretStorage. It is never written to settings or git.',
				password: true,
				ignoreFocusOut: true,
			});
			if (!key) return;
			await leaderboard.setApiKey(key);
			vscode.window.showInformationMessage('AI Stupid Level API key saved. Leaderboard refresh queued.');
		}),
		vscode.commands.registerCommand('openEditorsTools.clearAslApiKey', async () => {
			await leaderboard.clearApiKey();
			vscode.window.showInformationMessage('AI Stupid Level API key removed.');
		}),
		vscode.commands.registerCommand('openEditorsTools.leaderboardInfo', async () => {
			const snapshot = leaderboard.getSnapshot();
			snapshot.hasKey = await leaderboard.hasKey();
			const lines = infoLines(snapshot);
			if (!snapshot.hasKey) lines.push('No API key set. Run "Agent View: Set AI Stupid Level API Key".');
			vscode.window.showInformationMessage('Leaderboard', { modal: true, detail: lines.join('\n') });
		}),
		vscode.commands.registerCommand('openEditorsTools.refreshLeaderboard', async () => {
			await leaderboard.refreshNow({ reason: 'manual' });
			leaderboardView.render();
		}),
		// The layout this panel is built for: file tree, then chats, then the
		// chat itself. The panel is the one location VS Code lets us stand up as
		// a column, so the container defaults there and this moves the panel to
		// the left of the editor. Undo is one palette entry away
		// (View: Move Panel to Bottom).
		vscode.commands.registerCommand('openEditorsTools.arrangeLeft', arrangeLeft),
		vscode.commands.registerCommand('openEditorsTools.gatherViews', gatherViews),
		// One click back to the full four-column layout after it drifts:
		// Explorer | Agent View | Claude chats | Codex chats. Every step is
		// best-effort on its own — a failing workbench command must not stop
		// the tab herding behind it.
		vscode.commands.registerCommand('openEditorsTools.arrangeLayout', async () => {
			const step = async (name, fn) => {
				try { await fn(); } catch (err) { log(`arrangeLayout: ${name} failed — ${err.message}`); }
			};
			// Panel to the left with Agent View showing, Explorer sidebar up.
			await step('arrangeLeft', () => arrangeLeft());
			await step('explorer', () => vscode.commands.executeCommand('workbench.view.explorer'));
			// Exactly two side-by-side editor groups. setEditorLayout folds
			// surplus groups' editors into the survivors; nothing is closed.
			await step('setEditorLayout', () => vscode.commands.executeCommand('vscode.setEditorLayout', {
				orientation: 0,
				groups: [{}, {}],
			}));
			// Claude tabs into group 0, Codex conversation tabs into group 1.
			// One stray at a time, re-reading tabGroups after every move —
			// each move renumbers the indices the next one needs. The guard
			// caps a host that refuses to move a tab.
			await step('moveTabs', async () => {
				for (let guard = 0; guard < 100; guard++) {
					const strayClaude = claudeTabs().find((t) => t.groupIndex !== 0);
					const strayCodex = codexTabs().filter((t) => t.conversationId).find((t) => t.groupIndex !== 1);
					const stray = strayClaude || strayCodex;
					if (!stray) break;
					const target = strayClaude ? 0 : 1;
					await activateTab(stray.groupIndex, stray.tabIndex);
					await vscode.commands.executeCommand('moveActiveEditor', {
						to: stray.groupIndex > target ? 'left' : 'right',
						by: 'group',
						value: Math.abs(stray.groupIndex - target),
					});
				}
			});
			// Land in the Claude column.
			await step('focus', () => focusGroup(0));
		}),
		vscode.commands.registerCommand('openEditorsTools.refreshChats', () => {
			usage.refreshAll();
			usageView.render();
			leaderboard.maybeRefresh('refresh-command');
			leaderboardView.render();
			provider.refresh();
		}),
		vscode.commands.registerCommand('openEditorsTools.focusChat', activateTab),
		vscode.window.tabGroups.onDidChangeTabs(scheduleRefresh),
		vscode.window.tabGroups.onDidChangeTabGroups(scheduleRefresh),
		// Switching tabs is what clears an unread mark, and it has to feel
		// instant — the 1.5s transcript debounce is for file writes, not clicks.
		vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
		vscode.window.onDidChangeWindowState(() => provider.refresh()),
		{ dispose: () => { if (pending) clearTimeout(pending); clearInterval(sweep); clearInterval(usageTick); leaderboard.dispose(); provider.stopSpinner(); watchers.forEach((w) => w.close()); } }
	);
}

// Exported so the transcript maths can be checked against real .jsonl files
// outside VS Code by a local test harness.
module.exports = {
	register,
	_internal: {
		readTranscript, projectDirFor, ratesFor, formatAge, formatTokens, formatCost,
		stateOf, liveSessionIds, CodexIndex, codexConversationId,
		subagentsFor, promptLabel, readSubagentSummary, threadLabel,
		columnOf, claudeColumn, codexColumn, claudeTabs, codexTabs,
		resolveCodexTarget, openCodexInSidebar, openCodexInEditor, newCodexChat,
	},
};
