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

## Accounts panel

Opt-in (`openEditorsTools.accounts.enabled`); code in `accounts.js` (vscode-free) and
`accountsView.js`. Measured with Claude Code 2.1.322 on 2026-11-11:

- **`/login` with a second account forks every chat.** Each transcript carries a
  `{"type":"session-owner","accountUuid":…}` line. After a login as another account, an old
  chat refuses to send ("This session belongs to another account, so nothing was sent") and
  offers Change login or "Copy to … and continue", which creates a duplicate.
- **`CLAUDE_CODE_OAUTH_TOKEN` avoids that.** In the `env` block of `~/.claude/settings.json` it
  replaces the stored login: a wrong token failed with 401, a good one answered. While it is
  set, Claude Code's owner check has no current account (`GC()` returns false with the
  variable set, so `NDe()` yields nothing) and old chats continue on the token's account.
- **A setup-token is inference-only.** Claude Code's own text says so ("limited to
  inference-only", no Remote Control, no claude.ai connectors). The free check is
  `POST /v1/messages/count_tokens`: 200 for a `/login` token, and the reply names the
  organization in `anthropic-organization-id`. On 2026-11-23 the add flow turned down a fresh
  setup-token twice (read from the terminal, then pasted) on that check. Since 0.16.2 a token
  count_tokens does not accept gets `claude -p "Reply with just: ok"` with the token as
  `CLAUDE_CODE_OAUTH_TOKEN` (`--setting-sources project --strict-mcp-config
  --no-session-persistence`, in the temp dir, about 4 s, one tiny Haiku turn on that account).
  Only that run may refuse a token: a wrong one answered "API Error: 401 OAuth access token is
  invalid". A plain `/v1/messages` call with an OAuth bearer answers 429 outside Claude Code,
  so it is no test.
- **The weekly figure rides on every reply.** Claude Code's replies carry
  `anthropic-ratelimit-unified-7d-utilization=0.34` (a fraction), `-7d-reset=1794888000`
  (epoch seconds) and `-7d-status` (`allowed`, `allowed_warning`, `rejected`). A verified Ultra
  account sends no 5-hour headers. The router records them per token fingerprint in
  `~/.agent-view/account-usage.json` (8 days, 20 entries: the `/login` access token has the
  same `sk-ant-oat01-` prefix and rotates).
- **Reading the token from `setup-token`.** Shell integration's `executeCommand` +
  `read()` returns the raw output. A narrow terminal wraps the token, so
  `tokenCandidates` offers joined and unjoined variants and the checks above pick the one that
  works. The terminal is disposed once the token is stored; when nothing was stored it stays
  open, because the token may be on screen there and nowhere else. The token never reaches a
  log.


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

**Thread names have two stores.** `threads.name` in sqlite is a mirror. `session_index.jsonl` is an
append-only log with one `{id, thread_name, updated_at}` record per naming event, and the newest
record per id is the name Codex's own window shows. Since 2026-09-19 a rename reaches only the log,
and a thread that had a mirrored name loses it when Codex resumes the chat and re-derives the row
from its rollout (name NULL, title back to the first message). The panel therefore reads the log
first (`readNameLog`, cached on mtime+size, tail-read past 8 MiB) and falls back to `threads.name`,
then `threads.title`. Each entry records its `titleSource` (`log`, `name`, `title`) for debugging.
`tests/codextitles.js` pins this, including a check against the real install.

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

| Badge | Meaning |
| --- | --- |
| orange `?` | The agent asked a multiple-choice question (`AskUserQuestion`) or shows a plan to approve (`ExitPlanMode`) and is blocked on your answer |
| blue `●` | The agent is working right now (`running`), or its turn ended while background agents, workflows or monitors it waits for still run (`background`) |
| green `●` | A reply you have not read (`unread`), or a chat you set to **Mark as Unread** (`marked`) |

A read, finished chat stays unmarked: it is the resting state.

**Mark as Unread** (right-click an open Claude chat) stores `{ at, armed, label }` per session in
globalState (`openEditorsTools.markedUnread`, newest 500). The mark is set unarmed, so reading on
in the tab you marked it from does not clear it. It is armed when another tab comes to the front
of the active group (a tab event, which also fires while the Chats view is hidden; `label` is the
tab's label for that), when a render finds the chat's tab not in front, or when the chat has no tab
here (closed). A window that only lost focus arms nothing. Looking at the tab again (in front,
window focused) after that clears the mark, and so does a reply you type (`lastTypedAt` after the
mark). A running chat or an open question still shows its own badge. globalState is shared by
every window, so a flush applies only this window's changed marks onto what is stored and adopts
the result: one window clearing or setting a mark does not undo another's.

State is derived from these signals (`parseRecords`, `stateOf`, `withBackground`):

- **Only the conversation's own records count.** Claude Code 2.1.330 also logs every request
  body as an `api-request-blob` record: the conversation so far, old `tool_use` blocks included.
  Read as calls, those replays reopened answered questions. Across 107 transcripts (2026-11-24)
  that showed a stale `?` for 53 h while the agents worked. Records with `isSidechain` belong to
  a subagent and are skipped too.
- **Open calls belong to the newest answer.** Each `tool_use` id clears when its `tool_result`
  lands. Every call is answered before the next request, so calls of an older answer (`message.id`)
  that are still open are leftovers of an aborted turn and are dropped. A prompt or an interrupt
  (`[Request interrupted by user`) also clears them.
- **Awake.** An answer is written only once it is complete, so after a prompt the first record of
  the turn can be minutes away. The parser keeps `awake`: true after any input (prompt, task
  notification, injected context, hook feedback, tool result), an `api-request` record (a request
  sent) or a `system` `api_error` (a retry); false after an answer with a final stop reason
  (`end_turn`, `stop_sequence`, `max_tokens`, `refusal`), an interrupt or a local command
  (`system` `local_command`, `<local-command-stdout>`). A slash command's echo and the
  local-command caveat change nothing. Before this, a chat showed "done" for 25 h of work in the
  same 107 transcripts (mostly the thinking time after a prompt and compaction).
- **Background.** A turn that ended while the chat's background agents, workflows, tasks or
  monitors still run reads `background` (blue): the agent goes on when they report back. A
  subagent counts only when it wrote after the chat's last reply (a foreground agent finishes
  before it). Background shells and persistent monitors stay out, since they never report back.
- **`~/.claude/sessions/<pid>.json`**, which exists only while a session's process is alive. A
  closed or crashed chat is idle no matter what its transcript's last turn looked like. Claude
  Code 2.1.330 also keeps its own word there: `status` `busy` (a request or delegated work
  running), `idle`, or `waiting` with `waitingFor` (a dialog, a permission, an input it needs),
  stamped `statusUpdatedAt`. `waiting` reads as `?`. `busy` and `idle` count only when stamped
  after the transcript's last write: `idle` then ends a turn the transcript left open (a killed
  request, a failed retry), `busy` covers what writes no record (a stop hook running). `idle`
  never hides an open question.

`node tests/tools/status-replay.js [days]` replays the transcripts of the last days record by
record through `readTranscript` and `stateOf` and compares the badge with what the whole transcript
proves afterwards. On 2026-11-24, 107 transcripts and 1233 h on screen: 0.16.3 showed the right
state 93.4 % of the time (53 h stale `?`, 25.6 h "done" while working), 0.16.4 99.7 %; most of the
rest is blue for sessions a reload killed, which the live-process check turns idle.
`tests/statustest.js` holds one synthetic case per rule. The saved parse states are version 3;
states saved by version 2 still hold replayed calls and are read again from the start.

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

Package and install a `.vsix`, then run `Developer: Reload Window`:

```sh
npx @vscode/vsce package
code --install-extension agent-view-<version>.vsix --force
```

Copying files into a new `tuscheteam.agent-view-<version>` folder does **not**
install it. VS Code 1.139 scanned such folders while the copy was still running,
logged `Unable to read file ...package.json`, never retried, and kept loading the
version listed in `~/.vscode/extensions/extensions.json`. Check that file (or the
extension host log) after an install to see which folder actually runs.

Do **not** delete the folder without also removing its `extensions.json` entry, or
`code --install-extension` fails with `Please restart VS Code before reinstalling`.
