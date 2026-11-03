# Selected upstream improvements through v0.14.2

This remains the local v0.12.1 UI on Pi 1.5.0, not an upstream replacement.

- Idle hidden-page streams/file watches: `70b2947`; preserve namespaced external-runtime stream leases.
- CLI-identical carried tool order: `f3bd2a7`, `c319c85`.
- Compaction queue and recall: `a295025`; bypass interrupt-steer only while manual compaction owns the session.
- Unconfirmed/failed send recovery: `02eee05`; retain local continuation, prompt suggestions and error presentation.
- Interrupted built-in child display/settlement: `22f9eea`, `98ad390`; no writable child UI or notification policy changes.
- Shared model runtime TTL: `15c52bb` (60 minutes; explicit reload still invalidates).
- Model scope toggle, Git tree/list, SVG preview, formula source copy and custom-message layout are selectively migrated in the same batch.
- Security dependencies: Next.js 16.4.4, undici 8.12.3; lockfile updates zod 4.6.7 and DOMPurify 3.4.17.

Excluded: side chats, toolbar/debug additions, fee lines, notification changes, global mobile/layout/font changes.
Preserve theme, Ghostty, collapsed process details, read-only package-subagent history and all recovery adapters.
Release identity and actual acceptance live in `../../native-agent-switcher/local-update.json` and the deployment state, not this source note.
