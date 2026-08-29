#!/usr/bin/env python3
"""Stop hook: enforce the user's reply-length rules by blocking, not warning.

The earlier version printed a systemMessage. A systemMessage is shown to the
USER; it is never handed back to the model, so the rule was a smoke alarm
pointed at the wrong room. It fired correctly and changed nothing, fifteen times
over.

This blocks instead: `{"decision": "block", "reason": ...}` sends the reason
back as an instruction and the reply has to be written again. `stop_hook_active`
guards the obvious failure mode, a block that blocks its own replacement.

Limits mirror the "~8 bullets / ~150 words" ceiling in CLAUDE.md, plus the rule
that actually gets broken: prose paragraphs where bullets were asked for.
"""
import json
import re
import sys

# 60 is the target the style aims for; the hook only fires past the grace
# band, because a 65-word reply rewritten to 58 is the same reply twice.
WORD_LIMIT = 90
BULLET_LIMIT = 8
PROSE_LINE_WORDS = 14     # a non-bullet line this long is a paragraph
PROSE_LINES_ALLOWED = 2   # a lead line and one closer

BULLET_RE = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+")
HEADING_RE = re.compile(r"^\s*#{1,6}\s+")


def last_assistant_text(path):
    text = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Subagent turns share the transcript; they are not the reply the
            # user just read, so they must not clobber it.
            if obj.get("isSidechain"):
                continue
            msg = obj.get("message") or {}
            if obj.get("type") != "assistant" and msg.get("role") != "assistant":
                continue
            content = msg.get("content")
            if isinstance(content, str):
                if content.strip():
                    text = content
            elif isinstance(content, list):
                parts = [c.get("text", "") for c in content
                         if isinstance(c, dict) and c.get("type") == "text"]
                if any(p.strip() for p in parts):
                    text = "\n".join(parts)
    return text


def measure(text):
    """(words, bullets, prose_lines) ignoring code fences and tables."""
    lines, in_fence = [], False
    for raw in text.splitlines():
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if raw.lstrip().startswith("|"):      # markdown table
            continue
        lines.append(raw)
    body = "\n".join(lines)
    bullets = sum(1 for ln in lines if BULLET_RE.match(ln))
    prose = sum(1 for ln in lines
                if ln.strip()
                and not BULLET_RE.match(ln)
                and not HEADING_RE.match(ln)
                and len(ln.split()) >= PROSE_LINE_WORDS)
    return len(body.split()), bullets, prose


def main():
    try:
        # lstrip the BOM: piping the payload in from PowerShell adds one, and a
        # BOM makes json.loads throw.
        payload = json.loads(sys.stdin.read().lstrip("﻿"))
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    # Never block a reply that is already a rewrite: two blocks in a row is a
    # loop, and a loop is worse than a long answer.
    if payload.get("stop_hook_active"):
        return
    path = payload.get("transcript_path")
    if not path:
        return
    try:
        text = last_assistant_text(path)
    except OSError:
        return
    if not text:
        return

    words, bullets, prose = measure(text)
    over = []
    if words > WORD_LIMIT:
        over.append("%d words, the ceiling is %d" % (words, WORD_LIMIT))
    if bullets > BULLET_LIMIT:
        over.append("%d bullets, the ceiling is %d" % (bullets, BULLET_LIMIT))
    if prose > PROSE_LINES_ALLOWED:
        over.append("%d prose paragraphs, at most %d are allowed"
                    % (prose, PROSE_LINES_ALLOWED))
    if not over:
        return

    print(json.dumps({
        "decision": "block",
        "reason": ("That reply broke the reply-length rule: " + "; ".join(over) + ". "
                   "Write it again as bullets: one lead line with the outcome, then "
                   "at most %d bullets of one fact each, at most %d words in total. "
                   "Numbers as evidence, not narration. Whatever does not fit belongs "
                   "in the commit message or the docs, not in chat. Do not apologise "
                   "for the rewrite and do not mention this rule; just give the "
                   "shorter reply. Start the rewritten reply with the exact line "
                   "──── final ──── so the reader can skip the "
                   "draft above." % (BULLET_LIMIT, WORD_LIMIT)),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
