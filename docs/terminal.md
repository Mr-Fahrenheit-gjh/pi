# Workspace Terminals

The Explorer terminal action opens or focuses a terminal for its selected cwd
in the right panel's existing tab bar. Each terminal tab keeps the cwd it was
created with. Files still mount only their active viewer; terminal panels stay
mounted behind inactive tabs, hidden panels, and session or project switches.

## Renderer (local Ghostty integration)

The browser uses pinned `ghostty-web@0.4.0`, not a native Ghostty window.
`lib/ghostty-terminal.ts` loads its WASM from the versioned same-origin URL
`/vendor/ghostty-web/0.4.0/ghostty-vt.wasm`; no CDN is involved. Initialization
is shared, failed initialization is retryable, and unmounting before it finishes
must not create a shell. The PTY and SSE protocols below are unchanged.

`bin/prepare-ghostty.mjs` runs before builds and after normal npm installation.
It copies the pinned WASM/license and applies narrow, idempotent ESM patches:
CJK continuation cells do not become copied spaces; live palette changes repaint
without resetting the emulator; full font ascent/descent prevents the first bold
row from clipping. It refuses an unfamiliar upstream source shape.
After changing this dependency patch, use a fresh webpack cache: Next may cache
node_modules by package version and otherwise retain the unpatched module.

Ghostty's key handler returns **true for handled keys**, opposite to xterm.
Cmd+A selects terminal output, Cmd+C (or Ctrl+C with selection) copies, Cmd+K
clears the viewport; Ctrl+C without selection still interrupts the process.
Paste uses the emulator's bracketed-paste method. Toolbar controls provide
copy, paste, clear and 8–72px font zoom without replacing the shell.

The terminal follows the resolved web theme (including system changes in Auto).
Paper, text, cursor and selection use the web palette; ANSI colors use coordinated
light/dark palettes. `TerminalPanel` observes theme attributes and updates the
renderer in place, preserving its canvas, scrollback, scroll position and PTY.
The 0.4 WASM bridge exposes only resolved RGB, not semantic color indices: the
pinned patch maps exact immutable base-palette values at paint time. Arbitrary
true colors are preserved except exact matches to those 18 base RGB values.
The default background uses a distinct near-white base so explicit RGB/ANSI-256
white remains white, rather than becoming a background alias. Resets retain the
same base palette. No CSS inversion or shell-output replay is used.
The contenteditable host's native caret is transparent; the real terminal cursor
and input/IME plumbing remain intact.

The custom wheel handler respects DEC mouse-reporting modes: in a fullscreen app
such as Pi, trackpad movement becomes SGR (or legacy) mouse wheel reports, not
Ghostty 0.4's synthetic Up/Down keys. Fractional pixel deltas accumulate by cell
height. Normal-screen scrollback retains native smooth scrolling. An alternate
screen without mouse reporting does not receive fake arrow keys; use that app's
own keyboard scrolling. Pinch gestures do not become terminal input.

The terminal now has no permanent toolbar: no engine/cwd row, font buttons,
copy/paste/clear/restart buttons or Open menu. The canvas fills that space; the
existing terminal tab, PTY, keyboard copy/paste/clear and native font preferences
remain. Reconnect is offered only on an actual terminal error.

Local HTML in the file panel already uses a direct `iframe srcDoc` with
`sandbox="allow-scripts"`, not a screenshot stream or Chrome input relay.
Its rendered Preview and Source views remain available, with the existing whole
HTML cap and chunked source behavior. The iframe has no `allow-same-origin`,
so a preview script cannot read the authenticated parent. Normal websites use
the user's external browser/split-screen workflow.

The removed terminal Open menu no longer restores a browser-mode session or
starts a background Chrome page. Existing browser API/profile code is retained
as historical implementation rather than broadly rolled back in this limited
HTML/toolbar task; no user browser profile or credentials are deleted.

`GET /api/terminal/preferences` invokes the installed native
Ghostty's `+show-config` (bounded time/output, no shell or request-controlled args)
and exposes **only** font family and logical font size. This respects the native
config filename, includes and precedence without exposing commands or environment
variables. The font's logical size maps to CSS pixels, matching macOS logical
screen units. Font names refer to fonts installed on the browser's device; a remote
client must have them installed too. Missing Ghostty/config falls back to installed
Nerd Font families then monospace. Config is refreshed on window focus without
replacing the PTY/SSE; manual toolbar zoom survives refresh. Settings' code font no
longer changes the terminal. `font-thicken` and `adjust-cell-height` cannot be
mirrored by the 0.4 renderer and are not passed as unsupported options.

The 0.4 API supports font family/size but not xterm's `fontWeight`, `lineHeight`
or `screenReaderMode`; do not silently pass these unsupported options. This
renderer does not provide xterm's screen-reader output mode. Desktop keyboard,
canvas output and synthetic composition-event coverage do not constitute an
OS-level input-method or screen-reader acceptance test.

## Lifecycle

- Each new tab generates a random terminal ID before creation. Creation with
  the same ID and cwd is idempotent, including React Strict Mode's repeated
  effects. An existing ID cannot be reused for another cwd.
- `sessionStorage` retains terminal IDs, cwds, and the active terminal layout
  across refresh. Restored tabs first check the existing server instance and
  never silently start replacement processes after expiry or server restart.
- A new PTY gets a 120-second connection lease. Subscribing cancels expiry;
  the last subscriber leaving starts a new 120-second grace period. This also
  collects creations that never establish their initial connection.
- Hiding a panel, switching tabs, and unmounting a component only disconnect
  clients. Explicitly terminating a tab waits for creation and in-flight input
  before deleting the PTY. Restart waits for termination before creating a new
  ID. Failed termination leaves the tab available to retry.
- A shell exit closes the SSE stream and retains its output and exit code in
  the browser. Unobserved server records expire after the same grace period.
- Explicit termination and expiry signal the shell, escalating to SIGKILL after
  two seconds if it ignores SIGHUP. Server shutdown force-kills shells immediately.

## Transport

Output events carry a monotonically increasing UTF-16 offset in SSE `id`.
Reconnections use `Last-Event-ID` (or `after` on an explicit reconnect) and send
only the missing suffix. The server keeps at most 128 KiB of UTF-16 code units;
an older cursor triggers a terminal reset and bounded history replay. This is
bounded output history, not a serialized full-screen terminal snapshot. Slow
SSE consumers are disconnected once their response queue fills.

Input and resizes are serialized. Pending adjacent input is batched so remote
connections do not require one round trip per keystroke; large pastes are split
without splitting Unicode characters. Failed input is not retried because its
delivery may be ambiguous. Reconnect attaches to the same process with a fresh
writer; restart explicitly replaces the process.

`bin/prepare-terminal.js` repairs node-pty 1.1.0's macOS spawn-helper executable
bits during installation, including published/npm-installed Pi Web packages.

Pi Web pins node-pty to `1.2.0-beta.15`, which includes Linux x64 and ARM64
prebuilt binaries. Native module loading is deferred until terminal creation,
so missing or incompatible binaries produce a JSON error with repair instructions.
Empty or non-JSON API errors show the HTTP status and direct users to the server log.

If a native binary cannot load, run
`npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts` from the
installation directory (for npx, the cache directory containing `node_modules`).
On Debian/Ubuntu, install `python3` and `build-essential` first. This forces a
source build instead of reusing a missing or incompatible prebuilt binary.
Restart Pi Web after repair.

## Verification

Run `npm test` for native PTY, lease, output cursor, input queue, and storage
checks. After building in an isolated checkout, `npm run test:terminal` starts
an isolated production server and runs desktop Chrome checks using generated
session fixtures and real PTYs. Set `PI_WEB_TERMINAL_ROOT` to an independently
built package and `PI_WEB_TERMINAL_ARTIFACTS` to a result directory. It verifies
actual copied emulator output, Chinese text, keyboard/clipboard controls,
resize, alternate screen, reconnect, refresh, restart/termination, WASM failure
recovery and expired restored tabs. No model requests are made. The browser
check records its build ID, WASM hash, screenshot and log. Mobile validation is
not enabled by default.
