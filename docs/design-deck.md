# Design Deck in the right workspace

- Pi Web claims `design-deck:present` on the session event bus. The package skips Glimpse and OS browser launch only after a synchronous claim; ordinary CLI hosts retain their presenter.
- `/api/agent/running` includes live presentations, reusing the existing visible-tab poll. Nothing reads or persists deck capability URLs from conversation history.
- The session's Design Deck tab reuses NativeBrowser and host-side Chrome, so remote clients also work. Tabs, panel collapse and session switches leave live pages mounted. A stable presentation-owned browser ID reconnects across refreshes/windows; client unmount cannot close it. Submit, Cancel, abort and session shutdown remove the presentation and close its page. Browser creation validates the live ID/URL before and after awaiting Chrome, preventing stale pages.
- The `embedded=1` page does not send Cancel on unload; explicit cancellation and the package's heartbeat/idle timeout remain. Browser refresh can reconnect while the server is live.
- No SDK UI fields or package dependencies are added. The source adapter is version-checked against pi-design-deck 0.5.1 and must be reviewed for any upstream change.

## Activation (not performed by source validation)

Both pieces must ship together: this Web source and `scripts/patch-design-deck.mjs`.
Use the existing release guard with `upgrade_when_idle.py --prepare <history-session> --design-deck`, then its authorized `--apply`.
Prepare patches only an offline copy and binds the two files' hashes, modes, package metadata and adapter identity. After the idle gate has stopped Web, apply backs up both installed originals before replacing either file and starting the new Web package.
Do not run the adapter directly on a live shared installation. Confirm no independent CLI/runner is using the shared extension; the Web guard does not authorize stopping those hosts.
Rollback first proves the new service is idle, then restores both original files and the prior Web package; unknown edits or unknown/busy host state block recovery rather than overwriting active work.
Tests use temporary copies/stubs, never modify the installed extension or restart 30141.
