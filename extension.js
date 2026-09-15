const vscode = require('vscode');
const chatsView = require('./chatsView');

// Buttons live in the OPEN EDITORS pane header (MenuId.ViewTitle, scoped by the
// `view` context key each ViewPane sets to its own id). The per-row right-click
// menu is MenuId.OpenEditorsContext, which VS Code does not expose to
// extensions — so every action here targets the ACTIVE editor. Click a row
// first, then the button.
//
// The pin/unpin pair is two commands rather than one toggle because VS Code
// ships no toggle command; the buttons swap via the built-in
// `activeEditorIsPinned` context key in package.json.
async function forwardCommand(id) {
	try {
		await vscode.commands.executeCommand(id);
	} catch (err) {
		vscode.window.showErrorMessage(`Could not run ${id} — ${err.message}`);
	}
}

function activate(context) {
	const forward = (id) => () => forwardCommand(id);

	context.subscriptions.push(
		// openEditorsTools.newClaudeChat and .newCodexChat are registered in
		// chatsView.js — both must place the new tab in its agent's column,
		// which needs the column helpers there. A bare forward opened the chat
		// in whatever group happened to be active.
		// Called without arguments on purpose: the built-ins resolve the active
		// editor themselves, and forwarding the view's menu args misresolves them.
		vscode.commands.registerCommand('openEditorsTools.pin', forward('workbench.action.pinEditor')),
		vscode.commands.registerCommand('openEditorsTools.unpin', forward('workbench.action.unpinEditor'))
	);

	// Most-recently-used ordering. VS Code has none: explorer.openEditors.sortOrder
	// only offers editorOrder / alphabetical / fullPath, and unpinning changes
	// nothing here — pinned editors are merely forced to the front of the group.
	// So we do it by hand, sliding whatever you just activated to the top.
	let moving = false;
	const bumpActiveEditorToTop = async () => {
		if (moving) return;
		if (!vscode.workspace.getConfiguration('openEditorsTools').get('recentFirst')) return;

		const group = vscode.window.tabGroups.activeTabGroup;
		const tab = group && group.activeTab;
		// Pinned tabs keep their own hand-sorted block at the top — leave them be.
		if (!tab || tab.isPinned) return;

		const index = group.tabs.indexOf(tab);
		if (index <= 0) return;

		moving = true;
		try {
			// Overshooting is safe: the move clamps at the pinned block's boundary,
			// so an unpinned tab lands directly below the last pinned one.
			await vscode.commands.executeCommand('moveActiveEditor', { to: 'left', by: 'tab', value: index });
		} catch (err) {
			// Bad argument shape would fire on every single tab switch. Disarm.
			await vscode.workspace.getConfiguration('openEditorsTools')
				.update('recentFirst', false, vscode.ConfigurationTarget.Global);
			vscode.window.showErrorMessage(`Open Editors Tools: recent-first ordering failed (${err.message}). Setting turned off.`);
		} finally {
			moving = false;
		}
	};

	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabs(bumpActiveEditorToTop),
		vscode.window.tabGroups.onDidChangeTabGroups(bumpActiveEditorToTop)
	);

	// The CHATS tree — per-chat last activity, context size and API-equivalent
	// cost, read out of Claude Code's own session transcripts.
	chatsView.register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
