---
name: password-fill
description: Fill a saved macOS Keychain website password only when the authorized task already uses agent-browser and its login page is open. Not a generic login handler for Playwright or OpenCLI. Never asks for or shows a password.
---

# Password fill

The user's website passwords (imported from Chrome) live in the macOS Keychain. This tool fills
one into the login page that **agent-browser** currently has open. It only fills; you submit.

Tool: `node {{REPO_ROOT}}/工具/密码管理/当前页凭据填充/pw.mjs`

## Backend boundary

Use browser-harness to select the browser backend first. This skill only fills a page already open in an authorized agent-browser session.

Playwright and OpenCLI pages are not supported by this entry. Do not switch backends or open a second browser just to use saved passwords. Reuse the selected backend's existing login state; if login is still required, report this limitation and let the user log in there, without requesting their password. Adding another backend requires a separately reviewed adapter.

## Steps

1. If the site might already be logged in, check first; reuse an existing session when possible.
2. Confirm the login page is already open in the task's agent-browser session, and use that same `--session` below. Do not open or navigate a different browser session for this skill.
3. See which saved accounts match this site:
   ```
   node .../pw.mjs accounts [--session NAME]
   ```
4. Fill:
   ```
   node .../pw.mjs fill [--session NAME] [--account USERNAME]
   ```
   - One saved account → filled automatically. Several → you get `NEED_ACCOUNT` with the list; pick the one the task implies, or ask the user.
   - A login saved for a sibling subdomain (e.g. `www.` vs `login.`) is matched automatically.
5. Handle any captcha with the normal agent-browser tools, click the login button, then verify you are logged in.

## If the input boxes aren't detected

`FAILED` with reason `ELEMENT_CHANGED_OR_UNSUPPORTED`: take a fresh `agent-browser snapshot -i`, find unique CSS selectors (id, name, placeholder) for the two inputs, and retry:
```
node .../pw.mjs fill --user-selector '#username' --password-selector 'input[type=password]'
```
For a password-only second step (username shown as text), pass only `--password-selector`.

## Other results

- `NO_ACCOUNT` / `CREDENTIAL_MISSING`: nothing saved for this site. Ask the user to log in themselves.
- `SYSTEM_PERMISSION`: Keychain locked, a macOS prompt is waiting, or the user turned the feature off. Tell the user; do not retry in a loop.
- `NOT_HTTPS`: Stop filling. Only an already open HTTPS login page is supported; do not navigate or reopen a page to satisfy this check.
- `NO_BROWSER`: Stop filling and report that the task's existing agent-browser session is unavailable. Do not start, switch to, or open another browser/session for password filling.

## Rules

- Never ask the user to paste a password in chat, and never read a filled password back (no `eval`/`get value` on password fields, no screenshots with the password visible).
- Only log in for what the task needs. Don't change account settings, passwords, payment or security options.
- The on/off switch belongs to the user: `python3 .../permission.py setup|revoke` in their own Terminal. Don't run it.
