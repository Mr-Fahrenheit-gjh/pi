# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- On a desktop the sidebar shows the files below the sessions; Settings ›
  General › File browser brings back the Sessions | Files tabs and returns,
  without remounting the file tree (its file search keeps its query).
- Unknown sessions and paths outside the fixture project are rejected.
- Sidebar sessions open in browser tabs (`session-navigation.mjs`, desktop
  Chromium, one context so tabs share storage): a plain click and Enter
  select in place without a page load; Ctrl+click, middle-click and the row
  menu's Open in new tab (right-click, ⋯, T; just before Delete) open the clicked row's session in
  a new tab while the original keeps its own; both tabs keep their session
  through reloads; pinned and archived rows link the same way; nothing
  creates, copies or prompts a session; a missing session's link selects none
  in a fresh profile; a keyboard Fork puts focus on the copy row's link.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.

## Local practical-interaction check (playwright-mcp)

`interaction-practical.mjs` is a separate desktop-only check. Reuse existing
local dependencies; do not run the installation commands above for this check.
Build a separate candidate first, never the live checkout. Prepare its isolated
agent directory with `prepareInteractionFixture('/tmp/<task>/agent')` and start
that candidate with `PI_CODING_AGENT_DIR=/tmp/<task>/agent`, an empty
`PI_WEB_PASSWORD`, and `next start -H 127.0.0.1 -p 30158`.

Use the headless, independent-profile playwright-mcp page, not a newly launched
Playwright browser. Its VM does not support dynamic imports: import the module
in a local Node command and form the tool's code as follows (write only to the
task's temporary directory):

```js
import { runInteractionChecks } from './e2e/interaction-practical.mjs';
const options = { baseURL: 'http://127.0.0.1:30158', outputDir: '/tmp/<task>/evidence' };
const code = `async (page) => await (${runInteractionChecks.toString()})(page, ${JSON.stringify(options)})`;
```

Create `outputDir` before passing `code` to `browser_run_code_unsafe`. The check
returns `{ passed, checks, pageErrors, error? }`; verify `passed === true` rather
than treating tool/process exit as success. Save that result with the candidate's
`.next/BUILD_ID`. It uses synthetic SSE and an isolated screenshot image, without
model calls or user sessions. Coverage: cursor-anchor zoom, drag threshold and
pan, reset/keyboard/Escape/focus, iframe-crossing split drag and rollback/storage,
queued follow cancellation, detached reading and attached height-change follow.
For a panel-only regression, add `resizeOnly: true` to the options. This checks
both real separators when pointer capture is released before/after movement,
including iframe crossing, actual panel width, mouseup persistence, cleanup and
repeated drags, alongside the existing threshold/Escape/reset checks.

Finally close the test page and stop the exact candidate process. Candidate
verification is not a production publish or a live-service acceptance.
