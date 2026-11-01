// The model a chat ran on, kept across a reload.
//
// Claude Code stores no model per chat: a restored session starts on the
// default from settings.json, so every DeepSeek chat came back on Opus. The
// extension writes one pin per session here, and the router — the only place
// that sees every request — puts the pinned model back.
//
// The router keeps its own per-session memory of the model it last used, so an
// explicit /model always wins: a request that differs from what that session
// sent before is a choice, not a default.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function pinPath() {
	return path.join(os.homedir(), '.agent-view', 'model-pins.json');
}

function readPins() {
	try {
		const parsed = JSON.parse(fs.readFileSync(pinPath(), 'utf8'));
		if (!parsed || typeof parsed !== 'object') return { sessions: {}, chats: {} };
		// Version 1 was a flat session map.
		if (parsed.v !== 2) return { sessions: { ...parsed }, chats: {} };
		return { sessions: parsed.sessions || {}, chats: parsed.chats || {} };
	} catch (_) {
		return { sessions: {}, chats: {} };
	}
}

// A chat's identity that survives everything: the first thing the person
// typed. Session ids change when Claude Code restores a tab in a new process,
// and the model must not change with them.
function fingerprint(messages) {
	const list = Array.isArray(messages) ? messages : [];
	for (const m of list) {
		if (!m || m.role !== 'user') continue;
		const text = typeof m.content === 'string' ? m.content
			: Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ') : '';
		const cleaned = String(text).replace(/\s+/g, ' ').trim();
		if (!cleaned) continue;
		return crypto.createHash('sha1').update(cleaned.slice(0, 400)).digest('hex').slice(0, 16);
	}
	return null;
}

function fingerprintOfText(text) {
	const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
	if (!cleaned) return null;
	return crypto.createHash('sha1').update(cleaned.slice(0, 400)).digest('hex').slice(0, 16);
}

// Writes only when something changed: this runs after every render.
function writePins(next) {
	const current = readPins();
	let changed = false;
	for (const [sessionId, model] of Object.entries((next && next.sessions) || {})) {
		if (!sessionId) continue;
		if (model === null || model === undefined) {
			if (sessionId in current.sessions) { delete current.sessions[sessionId]; changed = true; }
			continue;
		}
		if (current.sessions[sessionId] !== model) { current.sessions[sessionId] = model; changed = true; }
	}
	for (const [fp, model] of Object.entries((next && next.chats) || {})) {
		if (!fp) continue;
		if (model === null || model === undefined) {
			if (fp in current.chats) { delete current.chats[fp]; changed = true; }
			continue;
		}
		if (current.chats[fp] !== model) { current.chats[fp] = model; changed = true; }
	}
	if (!changed) return false;
	const file = pinPath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ v: 2, sessions: current.sessions, chats: current.chats }, null, 2));
		fs.renameSync(tmp, file);
	} catch (_) { /* the chat still works, it just comes back on the default */ }
	return true;
}

module.exports = { pinPath, readPins, writePins, fingerprint, fingerprintOfText };
