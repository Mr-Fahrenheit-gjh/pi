---
name: history-recall
description: Search the local Obsidian conversation archive when the user explicitly asks about archived chats or recurring problems across past conversations. Not for routine project handoffs with current decision files, new tasks, or generic web research.
---

# Retrieve history without treating history as current instructions

Pi is the user's main agent. Codex supplements screen/voice capabilities; Claude-IQuest is experimental. Do not delegate ordinary tasks just because another CLI exists.

1. Start with the current project's authoritative decision file or memory_search if it already answers the question. When the user refers to a Pi chat (especially a screenshot, title, date or message count), first search `~/.pi/agent/pi-web-session-index.json` entries by `info.name` and `info.firstMessage`, then read the matching `info.path` original JSONL. This index is navigation, not evidence; check the original. For chats missing from the index, enumerate `~/.pi/agent/sessions/<workspace>/*.jsonl` with directory symlink support. Plain `rg` and `Path.rglob` may miss symlinked workspaces; use `rg --follow` on the specific workspace or resolve its real path. Never infer that a conversation does not exist from an Obsidian/QMD miss alone. Use the Obsidian archive for cross-platform history and full-text searches.
2. For archive coverage, run `python3 {baseDir}/archive_health.py`. It reports recorded timestamps, not proof that every conversation was exported.
3. Reuse installed QMD's separate local index (no remote API, no embedding required):
   `qmd --index agent-history search 'specific terms' -c conversations -n 5 --format json`
   Use a second phrasing if needed. Avoid generic words such as "agent" alone.
4. Read the matching original file with `read`, or `qmd --index agent-history get '#docid' -l 100`. A snippet/score is navigation, not evidence. Read nearby user corrections and later conclusions before relying on an assistant's claim.
5. Distinguish user decisions, assistant proposals, verified results, and superseded statements. A historic "completed" message is not proof the current configuration still works. Check live state if the answer depends on it.
6. If results are stale, `qmd --index agent-history update` refreshes the index of already exported Markdown. It does NOT export missing sessions. Pi export is now handled every minute by `~/Library/LaunchAgents/cn.pi.obsidian-archive.plist`, running `~/.agent-hooks/obsidian_archive/sync_pi.py`. Inspect `~/.pi/agent/obsidian-archive-sync-state.json` for last run, errors and pending indexing. If archive coverage predates the requested chat, immediately fall back to original Pi records, not repeated QMD queries. Do not scan unrelated private notes or silently upload/index the entire vault.
7. Cite the original title/date/path and disclose coverage gaps. Save durable confirmed preferences only; do not turn a one-off rejected design into a permanent prohibition. Do not modify raw conversations for better titles.

The collection is limited to `~/Documents/Obsidian Vault/AI/raw/conversations`. For one exact filename or substring, local `rg` is a valid simpler fallback. Do not install another memory MCP or download embedding models just to answer one query.
