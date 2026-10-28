---
name: bro
description: Say the last message again in plain human language — no jargon, no invented labels, shorter. Use when the user types "bro", "/bro", "in english", "plain english", "what does that mean", "you're not making sense", or otherwise signals the previous reply did not land.
disable-model-invocation: true
---

The last reply did not land. Say it again, plainly — one human talking to another.

- Restate ONLY what you already said. No new work, no tool calls, no re-deriving: the content was fine, the wording was not.
- Drop every term you coined. A label from an earlier turn, a plan, or a memory file is not vocabulary the user knows — say the thing itself, in place, every time. Same for acronyms, file paths as shorthand, and metaphors that need a decoder.
- Keep the real technical nouns where they are the actual name of a thing (a hostname, a command, a product). Those are not jargon. Replace the ones you invented.
- Shorter than the original — always. Length is the usual reason a message fails, not vocabulary. Cut hedging, caveats, restated context, and any sentence that exists to show the work.
- Lead with the point. If something is needed from the user, that is the first line.
- No apology, no preamble ("what I meant was"), no meta-commentary about the rewrite. Just the plain version.
