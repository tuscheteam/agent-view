// Chats that run on another machine, read through ssh.
//
// Long jobs started with `claude -p` on a server keep running when this
// machine is off, and their transcripts sit in ~/.claude/projects there. This
// module lists those transcripts, pulls the ones that changed, and parses them
// with the same reader the local chats use, so the panel shows one history
// whether a chat ran here or on a host.
//
// Everything is cached on disk: a render reads the cache and never waits on
// the network. A refresh asks each host for its index, fetches at most a few
// changed files per pass, and reports back so the panel can repaint.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SSH_TIMEOUT_MS = 20000;
const INDEX_EVERY_MS = 60000;
const MAX_FETCH_PER_PASS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// How much of a bigger transcript is read: enough for the title record and
// the model of the first reply.
const HEAD_BYTES = 1024 * 1024;
// A transcript untouched for a month is history, not work in progress.
const WINDOW_DAYS = 30;

// A host is a name, not an option: anything that starts with a dash, or that
// carries a character ssh or a shell would read, is refused before it reaches
// argv. user@host and [ipv6]:port stay allowed.
function safeHost(host) {
	const text = String(host || '').trim();
	if (!text || text.startsWith('-')) return null;
	return /^[A-Za-z0-9._@%:\[\]-]+$/.test(text) ? text : null;
}

function sshArgs(host, command) {
	return [
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=8',
		'-o', 'StrictHostKeyChecking=accept-new',
		'--',
		host,
		command,
	];
}

function runSsh(host, command) {
	return new Promise((resolve) => {
		execFile('ssh', sshArgs(host, command), { timeout: SSH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
			if (err) resolve(null);
			else resolve(String(stdout || ''));
		});
	});
}

// `find -printf` is GNU find, which every Linux host here has. The shell is
// quoted once for the remote side, so the node side never sees its quotes.
function indexCommand() {
	return `cd ~/.claude/projects 2>/dev/null && find . -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime -${WINDOW_DAYS} -printf '%T@|%s|%p\\n' 2>/dev/null | sort -rn | head -80`;
}

class RemoteChats {
	constructor({ hosts, dir, readTranscript, log, onChange, run }) {
		this.hostsFn = hosts;
		this.dir = dir;
		this.readTranscript = readTranscript;
		this.log = log || (() => {});
		this.onChange = onChange || (() => {});
		// Injectable so a test can answer without ssh.
		this.run = run || runSsh;
		this.cache = new Map();   // `${host}:${path}` -> { mtime, size, entry }
		this.pending = false;
		this.lastIndexAt = 0;
		this.failures = new Map(); // host -> consecutive failures
		this.nextTryAt = new Map();
		this.load();
	}

	hosts() {
		const list = this.hostsFn();
		if (!Array.isArray(list)) return [];
		return list.map(safeHost).filter(Boolean);
	}

	// Rows for the panel, straight from the cache.
	entries() {
		const out = [];
		for (const rec of this.cache.values()) {
			if (!rec.entry || !rec.host) continue;
			out.push({ ...rec.entry, host: rec.host, sessionId: rec.sessionId, lastActivity: rec.mtime, remote: true });
		}
		return out;
	}

	// Hosts that left the setting take their rows with them.
	prune() {
		const live = new Set(this.hosts());
		let changed = false;
		for (const [key, rec] of [...this.cache]) {
			if (live.has(rec.host)) continue;
			this.cache.delete(key);
			changed = true;
		}
		if (changed) this.onChange();
	}

	tick() {
		const now = Date.now();
		if (this.pending) return;
		if (now - this.lastIndexAt < INDEX_EVERY_MS) return;
		if (!this.hosts().length) return;
		this.lastIndexAt = now;
		this.refresh();
	}

	async refresh() {
		if (this.pending) return;
		this.pending = true;
		let changed = false;
		try {
			for (const host of this.hosts()) {
				const until = this.nextTryAt.get(host) || 0;
				if (until > Date.now()) continue;
				changed = (await this.refreshHost(host)) || changed;
			}
		} finally {
			this.pending = false;
			if (changed) this.onChange();
		}
	}

	async refreshHost(host) {
		const listing = await this.run(host, indexCommand());
		if (listing === null) {
			const fails = (this.failures.get(host) || 0) + 1;
			this.failures.set(host, fails);
			// A host that is off or unreachable waits, then is tried again; a
			// quiet log line is all it gets.
			this.nextTryAt.set(host, Date.now() + Math.min(600000, 60000 * 2 ** (fails - 1)));
			this.log(`remote ${host}: unreachable (${fails} in a row), next try in ${Math.min(10, 2 ** (fails - 1))} min`);
			return false;
		}
		this.failures.set(host, 0);
		this.nextTryAt.delete(host);
		const files = [];
		for (const line of listing.split('\n')) {
			const [mtime, size, rel] = line.trim().split('|');
			const at = Number(mtime) * 1000;
			if (!rel || !Number.isFinite(at)) continue;
			files.push({ rel, mtime: at, size: Number(size) || 0, key: `${host}:${rel}` });
		}
		// Forget chats that fell out of the window, so a stale row cannot live
		// on after its host dropped it.
		const seen = new Set(files.map((f) => f.key));
		let changed = false;
		for (const key of [...this.cache.keys()]) {
			if (!key.startsWith(`${host}:`)) continue;
			if (seen.has(key)) continue;
			this.cache.delete(key);
			changed = true;
		}
		const todo = files
			.filter((f) => {
				const rec = this.cache.get(f.key);
				return !rec || rec.mtime !== f.mtime || rec.size !== f.size;
			})
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, MAX_FETCH_PER_PASS);
		for (const file of todo) {
			// A long-running chat's transcript passes any sane cap. Its tail
			// is what changed, so a big file is read from the top only far
			// enough to learn its title and model; the row then shows the
			// host and age without token figures it cannot know.
			const headOnly = file.size > MAX_FILE_BYTES;
			// The listing names files relative to the projects folder, so the
			// fetch goes back there first instead of assuming a home directory.
			const read = headOnly
				? `head -c ${HEAD_BYTES} ${shellQuote(file.rel)} 2>/dev/null`
				: `cat ${shellQuote(file.rel)} 2>/dev/null`;
			const text = await this.run(host, `cd ~/.claude/projects 2>/dev/null && ${read}`);
			const entry = text ? await this.parse(host, file, text) : null;
			if (entry && headOnly) entry.partial = true;
			this.cache.set(file.key, { host, entry, mtime: file.mtime, size: file.size, sessionId: path.basename(file.rel, '.jsonl') });
			changed = true;
		}
		if (changed) this.save(host);
		return changed;
	}

	// The same reader the local list uses, on a copy in the cache folder: it
	// streams a file and knows every record shape already.
	async parse(host, file, text) {
		const dir = path.join(this.dir, host);
		const target = path.join(dir, `${process.pid}-${path.basename(file.rel)}`);
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(target, text);
		} catch (_) { return null; }
		try {
			const entry = await this.readTranscript(target);
			const cwd = new RegExp(String.raw`"cwd":"((?:[^"\\]|\\.)*)"`).exec(text.slice(0, 200000));
			if (cwd) {
				try { entry.cwd = JSON.parse(`"${cwd[1]}"`); } catch (_) { /* odd encoding */ }
			}
			return entry;
		} catch (_) {
			return null; // a half-written tail on the host
		} finally {
			try { fs.unlinkSync(target); } catch (_) { /* already gone */ }
		}
	}

	// The cache survives a reload: without it the panel starts empty and
	// fills six chats a minute.
	cacheFile(host) {
		return path.join(this.dir, host, 'index.json');
	}

	load() {
		this.loaded = this.loaded || new Set();
		for (const host of this.hosts()) {
			if (this.loaded.has(host)) continue;
			this.loaded.add(host);
			let parsed;
			try { parsed = JSON.parse(fs.readFileSync(this.cacheFile(host), 'utf8')); } catch (_) { continue; }
			for (const [rel, rec] of Object.entries(parsed || {})) {
				if (!rec || !rec.mtime) continue;
				this.cache.set(`${host}:${rel}`, { host, entry: rec.entry || null, mtime: rec.mtime, size: rec.size || 0, sessionId: rec.sessionId || path.basename(rel, '.jsonl') });
			}
		}
	}

	save(host) {
		const out = {};
		const prefix = `${host}:`;
		for (const [key, rec] of this.cache) {
			if (key.slice(0, prefix.length) !== prefix) continue;
			out[key.slice(prefix.length)] = { entry: rec.entry, mtime: rec.mtime, size: rec.size, sessionId: rec.sessionId };
		}
		try {
			fs.mkdirSync(path.dirname(this.cacheFile(host)), { recursive: true });
			const tmp = `${this.cacheFile(host)}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(out));
			fs.renameSync(tmp, this.cacheFile(host));
		} catch (_) { /* the memory cache still serves this window */ }
	}
}

// One argument, quoted for the remote shell.
function shellQuote(text) {
	return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

module.exports = { RemoteChats, shellQuote };
