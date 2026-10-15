# Local content-first workspace contract

This is the local composition contract layered over the upstream sidebar/session notes. Preserve the selected theme, body/code font preferences and official multicolour `public/icons/pi-mark.svg`; no proprietary fonts are bundled or downloaded.

## Layout
- Desktop left/right toggles stay at fixed viewport coordinates. The centre topbar has no surface or layout height and cannot intercept conversation pointers; the corner icons stay transparent. Hover previews use independent ephemeral state, never persisted open state; click pins/unpins. Both entry and exit stay outside flex layout until width reaches zero. Both hover previews and pinned panels use solid theme surfaces; do not restore transparency or gradient paint. Touch uses click only. Keep the right toggle outside the full-width panel\'s inert centre and reserve its area in both side-panel headers.
- The stacked sidebar has a serif Pi Web brand, a real search field and a full-width New row, regular system sans-serif navigation, a lighter theme-derived surface, and equal Settings/Restart footer actions. Use the same UI font for file names, project/Git names, menus, tasks, agent picker, working label and composer placeholders; preserve answer/code/brand fonts. Project groups have decorative folder icons; conversation rows offer direct pin/unpin using existing persistent family pins. Archive entry defaults hidden, with a browser-persisted Settings switch; archive storage is unchanged. The files-tab variant retains its functional tab controls.
- No chat title/session-actions menu or top-level robot button. Per-message accounting disclosures are absent for text and tool-only replies. Context usage is a read-only percentage ring, not an inspector opener.
- A composer has one rounded text-entry surface and a separate toolbar below. The file-upload icon is a document/upload mark; upload stays left, model/settings/context/stop stay below, send stays inside the entry. New-chat entry is taller; reply entry starts as one line and grows with the draft. Compact quoted composers retain sending.
- New-session project/Git controls sit below the entire composer. Placeholders are the single capitalized words Reply / Steer / Queue, independent of UI locale.
- Completed process disclosures are absent by default; running disclosures remain expandable and explicit search reveal can expose retained historical process. Do not delete stored records or blocking input/permission UI.
- The minimap reserves no permanent column. Rail/lock/preview appear only on hover or keyboard focus, with a compact scrollable preview, normal-weight text and theme-derived colours. Leave the real scrollbar usable.
- ChatWindow does not mount the bottom extension status/widget shelf. This is a presentation decision only: keep extension state/protocol and blocking permission/input/custom UI functional.

## Answer surfaces
- Assistant answers are unframed: no reply bubble, border, background or added padding. Preserve the existing user-message bubble, model icon/name, original block indices, streaming, answer/code fonts, alerts and written files. Long code/tables scroll inside their existing wrappers; compact screens must not overflow.
- Footer stays quiet until hover/keyboard focus (always usable on touch). Show copy plus a positive t/s value only when supported: live estimates use observed token growth; completed averages use output tokens divided by SDK-recorded request duration, including waiting. No timestamp-difference speed guesses, empty zero badges or added cost panels.

## Right workspace
- Permanent Tasks and Sub-agents tabs share the existing file/terminal workspace. They cannot be closed like documents. Mount their viewers only while the panel is open or previewed.
- AgentWorkspace selection is local and read-only. Use a width-bounded custom dropdown, short display summaries, status and exact run/step IDs. Identical display summaries may group records visually, never merge their identities; unknown revival scaffolding must not imply common lineage. Keep keyboard navigation, Escape, outside dismiss and per-record access. Native conversations use SubagentViewer; package children use PackageSubagentChat. Never call a main-session selection handler, start an agent or redirect the composer from that picker.
- GET `/api/sessions/[id]/todos` reads the existing live manager or the saved current branch, never starts a wrapper or calls `todo`. The `rpiv-todo-state` custom snapshot is authoritative over legacy `todo` result details, including a cleared list. Hide deleted tasks, preserve pending/in-progress/completed and poll only the visible mounted view. These are the same tasks used by the tool, not a second task database.

## Chat attachments versus project uploads
- Manual `@` selection inserts the existing path; it never uploads or copies.
- Composer uploads/drops use POST `/api/chat-attachments`, storing non-image files under the agent's private `chat-attachments/<sha256>/<filename>` and inserting absolute references. Same content/name reuses its file; changed content never overwrites an earlier reference. Images retain their inline prompt path.
- Browser file upload cannot recover an original absolute local path; it must save a server-side attachment. Never claim this is an original-file link. The attachment store is not the session cwd, and composer uploads must not refresh/write the project explorer.
- Enforce bounded multipart input, 25MB/file and 100MB/selection, safe names, private file permissions and symlink refusal; clean only files/directories created by a failed call. The file explorer's explicit Upload action keeps its existing project-upload semantics.

## Service restart
- ServiceRestartButton requires a confirmation dialog, waits for a changed server epoch and never resends an ambiguous POST. Manual AbortController/timeouts support Safari 16.2.
- POST `/api/service/restart` is only for same-origin loopback requests on 30141, the installed package cwd and the matching `cn.pi.web` launchd PID. Candidate/development instances reject it. No remote targets, arbitrary commands or force-busy overrides.
- Block running sessions, command admission/mutation waits, compaction, session creation, real extension work and live PTYs. Idle selected-browser leases are not work. Draining rejects new work and rechecks after asynchronous admission waits; Stop/control responses remain available.
- Implementation/testing does not authorize actually restarting the formal service. Unit/VM tests never run launchctl; candidate tests reject restart. A real restart still requires explicit operator confirmation and separate live verification.

## Verification
Use related component/restart/attachment/todo tests, typecheck/lint, then isolated headless checks: `e2e/workspace-design.mjs`, `e2e/ui-polish.mjs`, `e2e/chat-attachments.mjs`. Synthetic fixtures and candidate success are not production deployment evidence. Keep `local-customizations.json` markers aligned with this contract rather than restoring removed UI during migration.
