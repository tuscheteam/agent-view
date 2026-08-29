# Short replies — the part the extension cannot do

The quiet timeline (Agent View: *Restyle Claude Panel*) hides tool cards and
in-between messages. How MUCH Claude writes per reply is Claude Code
configuration, per machine. Three optional pieces, strongest first:

## 1. Output style (biggest effect)

Save as `~/.claude/output-styles/concise.md`:

```markdown
---
name: Concise
description: Codex-style replies - 60 words, 5 bullets, few words per bullet
---

Hard ceiling per reply: 60 words, 5 bullets. Write short on the FIRST pass -
replies stream to screen, so an over-long draft is already seen.

Shape: one lead line with the outcome, then bullets of a few words each, like
commit subjects. Numbers as evidence. `inline code` for commands and paths.
No preamble, no recaps, no teaching, no closing summary. Detail belongs in
commit messages or docs, never in chat. Expand only when the user explicitly
asks ("explain", "why", "walk me through").
```

Then in `~/.claude/settings.json` add:

```json
{ "outputStyle": "Concise" }
```

Applies to new chats immediately; running chats pick it up next restart.

## 2. CLAUDE.md rule (project-level reinforcement)

Add to your project's `CLAUDE.md`:

```markdown
## Replies
- Bullet-point checkpoint report, never prose paragraphs.
- Ceiling: 5 bullets / 60 words. Detail goes to commit messages, not chat.
- Expand only when explicitly asked ("explain", "why", "walk me through").
```

## 3. Enforcement hook (optional backstop)

A Stop hook that bounces a reply only when it is clearly over (90 words —
rewriting a 65-word reply into 58 shows you the same text twice). Copy
[`reply-length-check.py`](reply-length-check.py) to `~/.claude/hooks/` and
register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "python3 ~/.claude/hooks/reply-length-check.py", "timeout": 10 }] }]
  }
}
```

Windows: use the absolute path to `python.exe` — Claude Code hooks resolve
neither `python3` nor `~` there.

A bounced reply is rewritten below a `──── final ────` line; with the quiet
timeline on, the draft above it hides itself.
