# Internals & engineering notes

Design decisions and debugging findings behind the extension. User documentation lives in the [README](../README.md).


Adds three buttons to the header of the **OPEN EDITORS** pane:

| Button | Action |
| --- | --- |
| `+` | New Claude chat (`claude-vscode.editor.open`) — opens as its own tab, so it appears in the list right away |
| pin | Pin the active editor (`workbench.action.pinEditor`) |
| pinned | Unpin the active editor (`workbench.action.unpinEditor`) |

The pin and unpin buttons swap based on the built-in `activeEditorIsPinned` context key,
so only the applicable one is ever visible.

## Usage bars

A small webview sits above the chats — quota is what you check before starting work. One bar per
window, with the reset time under it. Percentages are **consumed**, not remaining.

It is a webview rather than two tree rows because a `TreeItem` description is plain
theme-coloured text: there is no way to paint a bar in a product's own colour. Fills come from the
logo files this extension already ships — Claude `#D97757` (the fill in `resources/claude.svg`),
Codex white (`resources/codex.svg`), dropping to that file's `#8E8E8E` on light themes where white
would vanish. Everything else is a VS Code theme token.

Two things that cost real debugging:

- **A CSP nonce covers `<style>` elements but not inline `style=` attributes.** With
  `style="width:12%"` the attribute is silently dropped and every bar renders full width — it
  reads as 100% used, with no console error. Widths are therefore generated as classes
  (`.w12 { width: 12% }`) inside the nonced stylesheet.
- **A second view unmerges the container.** VS Code registers extension containers with
  `mergeViewWithContainerWhenSingleView`, so while CHATS was the only view it had no pane header.
  Adding this one gives both panes their own 22 px header, and the container's minimum expanded
  height goes from 120 px to ~284 px.


## The CHATS view

A separate tree (Explorer → **Chats**, draggable next to OPEN EDITORS) with one row per open
Claude chat: `MY-PROJECT   12m · 450k/1.0M · $12.34` — last activity, context in play against the
model's window, and what the session's tokens would cost at list API rates. Hover for the full
breakdown (model, assistant turns, input/output, cache reads, 5m and 1h cache writes).

The built-in OPEN EDITORS rows can't carry any of this: Claude chats are
`createWebviewPanel("claudeVSCodePanel")` tabs with no URI, so a `FileDecorationProvider` badge
has nothing to attach to, and the row context menu (`MenuId.OpenEditorsContext`) is not exposed
to extensions.

### Codex chats

Codex conversations sit in the same list. The ChatGPT extension opens one as a custom editor
(`chatgpt.conversationEditor`) whose URI is `openai-codex://route/local/<conversationId>` —
unlike a Claude chat, the tab carries a real id, so rows key off that instead of the title.

Thread metadata comes from the `threads` table in `~/.codex/state_5.sqlite`, opened **read-only**
(Codex owns that database and may be writing it). It gives title, model, reasoning effort,
`tokens_used` and last-update time. `node:sqlite` is only unflagged from Node 23 on and the
extension host may be older, so there is a fallback to `~/.codex/session_index.jsonl`, which
carries names and timestamps but no token counts. The row tooltip names which source it read.

#### The black Codex panel

The ChatGPT extension's own **New Codex Agent** opens the editor at route
`/extension/panel`. The webview's router has no such route — its table is
`/local/:conversationId` and `/hotkey-window/thread/:conversationId` — so it falls back to
`/`, finds no component, and paints an empty page. The console says so outright: *"Matched leaf
route at location `/` does not have an element or Component … resulting in an 'empty' page."*
The logo appears for a moment (the app boots) and then the tab goes black.

Nothing local fixes it — not GPU rendering, not the webview cache. It's an upstream routing bug.

The editor host itself is fine, which the two buttons here exploit:

- **Open Codex Conversation in Tab** opens `openai-codex://route/local/<id>` through
  `vscode.openWith`. That URI carries its own route, so the tab renders.
- **New Codex Agent** (this extension's) lets the sidebar create the thread, watches `~/.codex`
  for the id that appears, then opens that in a tab. If no thread is persisted within 20 s —
  they usually only appear once they carry a message — it says so and leaves the sidebar open.

**No cost column on Codex rows.** These are OpenAI models and this extension has no verified
price list for them; an invented rate would be worse than none.

Status dots are Claude-only — the Codex thread record has no pending-tool or liveness signal to
derive them from.

### Closed chats

The live rows mirror open tabs, so closing a tab used to silently drop the chat from the panel —
the session itself lives on in the transcripts. Rows with a history icon are exactly those:
sessions active within the last 48 hours (setting `openEditorsTools.closedChatHours`, 0 hides
them) whose tab is gone. Clicking one reopens the session — `claude-vscode.editor.open` takes a
session id; the extension keys its panel registry on it, which is how its own sessions list opens
old sessions. Codex closed threads reopen through their `openai-codex://route/local/<id>` URI.

Newest transcript wins when several share a title, and a chat never appears twice — an open tab
suppresses its closed row.

### Status dots

Two states earn a badge, both meaning the chat wants something:

| Badge | Meaning |
| --- | --- |
| orange `?` | The agent asked a multiple-choice question and is blocked on your answer |
| blue `●` | The agent is working right now |

A finished chat stays unmarked — it is the resting state, and badging it would put a mark on
every row.

State is derived from three signals, all of which are needed:

- The **last assistant message's `stop_reason`**. `tool_use` means the turn is mid-flight;
  `end_turn` means it closed. This is the discriminator, because an aborted turn leaves its
  `tool_use` blocks unanswered forever — an aborted session had two orphaned `Bash` calls that read as
  "running" until `stop_reason` was brought in.
- **Unanswered `tool_use` blocks** — each `tool_use` id is cleared when its `tool_result` lands.
  An unanswered `AskUserQuestion` is what a pending multiple-choice question looks like.
- **`~/.claude/sessions/<pid>.json`**, which exists only while a session's process is alive. A
  closed or crashed chat is idle no matter what its transcript's last turn looked like.

Status rides as a `FileDecorationProvider` badge on a synthetic `claude-chat:` URI rather than a
tinted icon, because the row icon is the Claude asterisk — an SVG VS Code renders as-is and will
not recolor.

The numbers come from Claude Code's own transcripts in
`~/.claude/projects/<slug>/<session-id>.jsonl`. Each carries a `custom-title` record holding the
exact tab label — that is what lines a transcript up with a tab — plus one `usage` block per
assistant message. Files are cached by mtime+size, so a refresh only re-reads what changed
(multi-megabyte transcripts parse in on the order of 100 ms).

Cost uses the list rates: input/output per model, cache reads at 0.1x input, cache writes at
1.25x (5-minute TTL) and 2x (1-hour TTL). It is an API-equivalent figure — a Claude subscription
is not billed this way.

Clicking a row focuses that chat. There is no API to activate an arbitrary tab and a webview tab
has no URI to re-open, so it focuses the owning editor group and then jumps by tab index.

## Most-recent-first ordering

`openEditorsTools.recentFirst` (default `false`) slides the editor you just activated to
the top of its group, so the list reads most-recent-first.

VS Code offers nothing for this: `explorer.openEditors.sortOrder` takes only
`editorOrder`, `alphabetical` and `fullPath`, and unpinning everything changes nothing —
pinned editors are merely forced to the front of the group, they are not a sort mode.

Pinned tabs are skipped, so your hand-sorted pinned block stays put and only the rest
reshuffles. If the `moveActiveEditor` call is ever rejected, the setting turns itself off
rather than firing on every tab switch.

## Why buttons and not a right-click menu

VS Code builds a view's header toolbar from `MenuId.ViewTitle`, filtered by the `view`
context key that every ViewPane sets to its own id — so `view/title` with
`when: view == workbench.explorer.openEditorsView` lands in the OPEN EDITORS header.

The per-row context menu is a different menu, `MenuId.OpenEditorsContext`, which is
internal: the extension-facing name `openEditorsContext` does not exist in the workbench
bundle's menu schema. No extension can add entries there. Hence: click a row to make that
editor active, then use the header button.

Because of that, all actions target the **active** editor, not the row under the cursor.

## Install

Copy this folder into the extensions directory, using the `publisher.name-version`
convention for the folder name:

```sh
cp package.json extension.js README.md \
   ~/.vscode/extensions/tuscheteam.agent-view-<version>/
```

VS Code 1.132 scans that directory and registers the folder in
`~/.vscode/extensions/extensions.json` on its own — no `.vsix` needed. Run
`Developer: Reload Window` afterwards; a plain window reload picks up new files too.

Do **not** delete the folder without also removing its `extensions.json` entry, or
`code --install-extension` fails with `Please restart VS Code before reinstalling`.
