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

function pinPath() {
	return path.join(os.homedir(), '.agent-view', 'model-pins.json');
}

function readPins() {
	try {
		const parsed = JSON.parse(fs.readFileSync(pinPath(), 'utf8'));
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch (_) {
		return {};
	}
}

// Writes only when something changed: this runs after every render.
function writePins(next) {
	const current = readPins();
	let changed = false;
	for (const [sessionId, model] of Object.entries(next || {})) {
		if (!sessionId) continue;
		if (model === null || model === undefined) {
			if (sessionId in current) { delete current[sessionId]; changed = true; }
			continue;
		}
		if (current[sessionId] !== model) { current[sessionId] = model; changed = true; }
	}
	if (!changed) return false;
	const file = pinPath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
		fs.renameSync(tmp, file);
	} catch (_) { /* the chat still works, it just comes back on the default */ }
	return true;
}

module.exports = { pinPath, readPins, writePins };
