import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizePreviewUrl } from "./browser-preview";
import { chromeExecutableCandidates } from "./browser-executable";
import { isBrowserId } from "./browser-protocol";
import type { BrowserCommand, BrowserEvent, BrowserPageState } from "./browser-types";

type Params = Record<string, unknown>;
type ProtocolEvent = { method: string; params: Params; sessionId?: string };
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
const TITLE_BINDING = "__piBrowserTitleChanged";
const TITLE_OBSERVER = `(()=>{if(window!==window.top)return;let last='';const report=()=>{const title=document.title;if(title!==last){last=title;window.${TITLE_BINDING}(title)}};const install=()=>{new MutationObserver(report).observe(document.head||document.documentElement,{subtree:true,childList:true,characterData:true});report()};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install()})()`;

/** Private loopback CDP transport. No client-supplied endpoints, methods or JS. */
export class ChromeConnection {
  private writer: Writable;
  private closed = false;
  private serial = 0;
  private pending = new Map<number, { resolve: (p: Params) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly listeners = new Set<(e: ProtocolEvent) => void>();
  readonly ready: Promise<void>;
  constructor(child: ChildProcess) {
    this.writer = child.stdio[3] as Writable;
    const reader = child.stdio[4] as Readable;
    this.ready = Promise.resolve();
    let buffered = Buffer.alloc(0);
    reader.on("data", (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      if (buffered.length > 16 * 1024 * 1024) { this.close(); return; }
      let boundary: number;
      while ((boundary = buffered.indexOf(0)) >= 0) {
        const message = buffered.subarray(0, boundary).toString("utf8");
        buffered = buffered.subarray(boundary + 1);
      try {
        const m = JSON.parse(message);
        if (typeof m.id === "number") {
          const p = this.pending.get(m.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result ?? {}); }
        } else if (typeof m.method === "string") {
          for (const listener of this.listeners) listener({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
        }
      } catch { /* Ignore malformed protocol events, never log webpage data. */ }
      }
    });
    reader.on("close", () => this.close());
    reader.on("error", () => this.close());
    this.writer.on("error", () => this.close());
  }
  async send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    await this.ready;
    if (this.closed || this.writer.destroyed) throw new Error("Chrome disconnected");
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject: e => reject(new Error(`${method}: ${e.message}`)), timer });
      try { this.writer.write(JSON.stringify({ id, method, params, sessionId }) + "\0"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new Error(err(e))); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.writer.destroy();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Chrome disconnected")); }
    this.pending.clear();
  }
}

interface PageRecord {
  target: string; session: string; state: BrowserPageState;
  listeners: Set<(e: BrowserEvent) => void>;
  frame?: Extract<BrowserEvent, { type: "frame" }>;
  timer?: ReturnType<typeof setTimeout>;
  lastFrame: number;
  mainFrame?: string;
  mainRequest?: string;
  tail: Promise<unknown>;
  parents: { target: string; session: string; url: string; title: string }[];
}

export class BrowserManager {
  private child?: ChildProcess;
  private starting?: Promise<ChromeConnection>;
  private connection?: ChromeConnection;
  private pages = new Map<string, PageRecord>();
  private creating = new Map<string, Promise<BrowserPageState>>();
  constructor(private profile = process.env.PI_WEB_BROWSER_PROFILE || join(getAgentDir(), "browser", "chrome-profile")) {
    // Only the Chrome process launched by this manager, never the user's desktop Chrome.
    process.once("exit", () => { this.child?.kill("SIGTERM"); });
  }
  private async start(): Promise<ChromeConnection> {
    if (this.connection) return this.connection;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(): Promise<ChromeConnection> {
    const candidates = chromeExecutableCandidates();
    let executable: string | undefined;
    for (const path of candidates) { try { await access(path, constants.X_OK); executable = path; break; } catch { /* Try the next known Chrome location. */ } }
    if (!executable) throw new Error("Chrome is not installed on the Pi Web host");
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    if ((await lstat(this.profile)).isSymbolicLink()) throw new Error("Browser profile cannot be a symlink");
    const child = spawn(executable, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    this.child = child;
    const c = new ChromeConnection(child);
    child.once("error", () => c.close());
    child.once("exit", () => c.close());
    try { await c.send("Browser.getVersion"); await c.send("Target.setDiscoverTargets", { discover: true }); }
    catch (e) { child.kill("SIGTERM"); throw e; }
    c.listeners.add(e => this.event(e));
    this.connection = c;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.connection = undefined; this.child = undefined; c.close();
      for (const p of this.pages.values()) { if (p.timer) clearTimeout(p.timer); for (const send of p.listeners) send({ type: "closed" }); }
      this.pages.clear();
    });
    return c;
  }
  private emit(p: PageRecord) { for (const send of p.listeners) send({ type: "state", state: { ...p.state } }); }
  private event(e: ProtocolEvent) {
    if (e.method === "Target.targetCreated") {
      const info = e.params.targetInfo as Params;
      const opener = [...this.pages.values()].find(p => p.target === info.openerId);
      if (opener && info.type === "page") {
        const adopt = opener.tail.then(() => this.adoptPopup(opener, String(info.targetId)));
        opener.tail = adopt.catch(() => {});
      }
      return;
    }
    if (e.method === "Target.targetInfoChanged") {
      const info = e.params.targetInfo as Params;
      const p = [...this.pages.values()].find(p => p.target === info.targetId);
      if (p) { p.state.title = String(info.title ?? ""); const url = normalizePreviewUrl(String(info.url ?? "")); if (url) p.state.url = url; this.emit(p); }
      return;
    }
    if (e.method === "Target.targetDestroyed") {
      const p = [...this.pages.values()].find(p => p.target === e.params.targetId);
      if (p) {
        const parent = p.parents.pop();
        if (parent) { Object.assign(p, { target: parent.target, session: parent.session }); p.state.url = parent.url; p.state.title = parent.title; p.mainFrame = undefined; this.emit(p); void this.connection?.send("Target.activateTarget", { targetId: p.target }).catch(() => {}); void this.startFrames(p); void this.history(p).catch(() => {}); }
        else { if (p.timer) clearTimeout(p.timer); this.pages.delete(p.state.id); for (const send of p.listeners) send({ type: "closed" }); }
      }
      return;
    }
    const p = [...this.pages.values()].find(p => p.session === e.sessionId);
    if (!p) return;
    if (e.method === "Runtime.bindingCalled" && e.params.name === TITLE_BINDING) { p.state.title = String(e.params.payload).slice(0, 2048); this.emit(p); }
    else if (e.method === "Page.screencastFrame") {
      void this.connection?.send("Page.screencastFrameAck", { sessionId: e.params.sessionId }, p.session).catch(() => {});
      if (p.state.loading || Date.now() - p.lastFrame < 45) return;
      p.lastFrame = Date.now();
      if (typeof e.params.data !== "string" || e.params.data.length > 4 * 1024 * 1024) return;
      p.frame = { type: "frame", data: e.params.data, width: p.state.width, height: p.state.height, url: p.state.url };
      for (const send of p.listeners) send(p.frame);
    } else if (e.method === "Page.frameNavigated") {
      const f = e.params.frame as Params;
      if (!f.parentId) {
        p.mainFrame = String(f.id);
        const url = normalizePreviewUrl(String(f.unreachableUrl || f.url || ""));
        if (url) p.state.url = url;
        void this.history(p).catch(() => {}); void this.startFrames(p); this.emit(p);
      }
    } else if (e.method === "Page.navigatedWithinDocument" && e.params.frameId === p.mainFrame) {
      const url = normalizePreviewUrl(String(e.params.url ?? "")); if (url) p.state.url = url;
      void this.history(p).catch(() => {}); this.emit(p);
    } else if (e.method === "Network.requestWillBeSent" && e.params.type === "Document" && (!p.mainFrame || e.params.frameId === p.mainFrame)) { p.mainRequest = String(e.params.requestId); }
    else if (e.method === "Network.loadingFailed" && e.params.requestId === p.mainRequest && !e.params.canceled) { p.state.error = String(e.params.errorText); p.state.loading = false; this.emit(p); }
    else if (e.method === "Page.frameStartedLoading" && e.params.frameId === p.mainFrame) { p.state.loading = true; this.emit(p); }
    else if (e.method === "Page.frameStoppedLoading" && e.params.frameId === p.mainFrame) { p.state.loading = false; this.emit(p); }
    else if (e.method === "Page.loadEventFired") { p.state.loading = false; this.emit(p); void this.startFrames(p); void this.snapshot(p).catch(() => {}); }
    else if (e.method === "Page.javascriptDialogOpening") {
      p.state.dialog = { type: String(e.params.type), message: String(e.params.message).slice(0, 4096), defaultPrompt: String(e.params.defaultPrompt ?? "").slice(0, 4096) }; this.emit(p);
    } else if (e.method === "Page.javascriptDialogClosed") { delete p.state.dialog; this.emit(p); }
  }
  private async adoptPopup(p: PageRecord, target: string) {
    const c = this.connection!;
    if (p.parents.length >= 8) { await c.send("Target.closeTarget", { targetId: target }); return; }
    const session = String((await c.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId);
    p.parents.push({ target: p.target, session: p.session, url: p.state.url, title: p.state.title });
    p.target = target; p.session = session; p.state.loading = true; p.mainFrame = undefined;
    await c.send("Page.enable", {}, session); await c.send("Network.enable", {}, session); await this.observeTitle(p);
    await c.send("Emulation.setDeviceMetricsOverride", { width: p.state.width, height: p.state.height, deviceScaleFactor: 1, mobile: false }, session);
    const info = (await c.send("Target.getTargetInfo", { targetId: target })).targetInfo as Params;
    const url = normalizePreviewUrl(String(info.url)); if (url) p.state.url = url;
    p.state.title = String(info.title ?? ""); this.emit(p);
    await c.send("Target.activateTarget", { targetId: target }).catch(() => {}); if (p.target !== target) return; await this.startFrames(p); await this.snapshot(p).catch(() => {}); await this.history(p);
  }
  private async observeTitle(p: PageRecord) {
    await this.connection!.send("Runtime.enable", {}, p.session);
    await this.connection!.send("Runtime.addBinding", { name: TITLE_BINDING }, p.session);
    await this.connection!.send("Page.addScriptToEvaluateOnNewDocument", { source: TITLE_OBSERVER }, p.session);
    await this.connection!.send("Runtime.evaluate", { expression: TITLE_OBSERVER }, p.session);
  }
  private async startFrames(p: PageRecord) {
    if (!p.listeners.size) return;
    // A cross-origin navigation can temporarily have no active render frame.
    // The navigation/load events retry this read-only subscription, never input.
    await this.connection?.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1400, everyNthFrame: 1 }, p.session).catch(() => {});
  }
  private async history(p: PageRecord) {
    const h = await this.connection!.send("Page.getNavigationHistory", {}, p.session);
    const index = Number(h.currentIndex); const entries = h.entries as unknown[];
    p.state.canGoBack = entries.slice(0, index).some(entry => normalizePreviewUrl(String((entry as Params).url))) || p.parents.length > 0; p.state.canGoForward = entries.slice(index + 1).some(entry => normalizePreviewUrl(String((entry as Params).url))); this.emit(p);
  }
  private async snapshot(p: PageRecord) {
    const url = p.state.url;
    const result = await this.connection!.send("Page.captureScreenshot", { format: "jpeg", quality: 90 }, p.session);
    if (typeof result.data === "string" && url === p.state.url && !p.state.loading) { p.frame = { type: "frame", data: result.data, width: p.state.width, height: p.state.height, url }; for (const send of p.listeners) send(p.frame); }
  }
  get(id: string) { const p = this.pages.get(id); return p ? { ...p.state } : null; }
  touch(id: string) { const p = this.pages.get(id); if (p) this.armExpiry(p); }
  async create(id: string, url: string, width = 1000, height = 800): Promise<BrowserPageState> {
    if (!isBrowserId(id) || !normalizePreviewUrl(url)) throw new Error("Invalid browser page");
    const existing = this.get(id); if (existing) return existing;
    const pending = this.creating.get(id); if (pending) return pending;
    if (this.pages.size + this.creating.size >= 8) throw new Error("Too many browser pages; close an unused page first");
    const creating = this.createPage(id, normalizePreviewUrl(url)!, width, height);
    this.creating.set(id, creating);
    try { return await creating; } finally { this.creating.delete(id); }
  }
  private async createPage(id: string, url: string, width: number, height: number): Promise<BrowserPageState> {
    const c = await this.start();
    const target = String((await c.send("Target.createTarget", { url: "about:blank" })).targetId);
    try {
      const session = String((await c.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId);
      const p: PageRecord = { target, session, state: { id, url, title: "", loading: true, canGoBack: false, canGoForward: false, width, height }, listeners: new Set(), lastFrame: 0, tail: Promise.resolve(), parents: [] };
      this.pages.set(id, p);
      await c.send("Page.enable", {}, session);
      await c.send("Network.enable", {}, session);
      const tree = await c.send("Page.getFrameTree", {}, session);
      p.mainFrame = String(((tree.frameTree as Params).frame as Params).id);
      await this.observeTitle(p);
      await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, session);
      await c.send("Target.activateTarget", { targetId: target });
      const result = await c.send("Page.navigate", { url }, session);
      p.mainFrame = String(result.frameId ?? "");
      if (result.errorText) { p.state.error = String(result.errorText); p.state.loading = false; }
      this.armExpiry(p); return { ...p.state };
    } catch (e) { this.pages.delete(id); await c.send("Target.closeTarget", { targetId: target }).catch(() => {}); throw e; }
  }
  private armExpiry(p: PageRecord) { if (p.timer) clearTimeout(p.timer); if (!p.listeners.size) { p.timer = setTimeout(() => { void this.close(p.state.id); }, 10 * 60 * 1000); p.timer.unref(); } }
  async subscribe(id: string, send: (e: BrowserEvent) => void): Promise<(() => void) | null> {
    const p = this.pages.get(id); if (!p) return null;
    if (p.timer) clearTimeout(p.timer); p.listeners.add(send);
    send({ type: "state", state: { ...p.state } }); if (p.frame) send(p.frame);
    const target = p.target;
    await this.connection!.send("Target.activateTarget", { targetId: target }).catch(async () => {
      if (this.pages.get(id) === p && p.target !== target) await this.connection!.send("Target.activateTarget", { targetId: p.target }).catch(() => {});
    });
    await this.startFrames(p);
    void this.snapshot(p).catch(() => {});
    return () => { p.listeners.delete(send); if (!p.listeners.size) { void this.connection?.send("Page.stopScreencast", {}, p.session).catch(() => {}); this.armExpiry(p); } };
  }
  async command(id: string, command: BrowserCommand): Promise<{ text?: string }> {
    const p = this.pages.get(id); if (!p) throw new Error("Browser page expired or closed");
    const run = p.tail.then(() => this.dispatch(p, command));
    p.tail = run.catch(() => {}); return run;
  }
  private async dispatch(p: PageRecord, b: BrowserCommand): Promise<{ text?: string }> {
    const c = this.connection!;
    if (b.type === "navigate") {
      p.state.url = b.url; p.state.loading = true; delete p.state.error; this.emit(p);
      const result = await c.send("Page.navigate", { url: b.url }, p.session);
      if (result.errorText) { p.state.error = String(result.errorText); p.state.loading = false; this.emit(p); }
    } else if (b.type === "reload") { delete p.state.error; await c.send("Page.reload", {}, p.session); }
    else if (b.type === "back" || b.type === "forward") {
      const h = await c.send("Page.getNavigationHistory", {}, p.session);
      const entries = h.entries as Params[]; const index = Number(h.currentIndex);
      const candidates = b.type === "back" ? entries.slice(0, index).reverse() : entries.slice(index + 1);
      const entry = candidates.find(entry => normalizePreviewUrl(String(entry.url)));
      if (entry) await c.send("Page.navigateToHistoryEntry", { entryId: entry.id }, p.session);
      else if (b.type === "back" && p.parents.length) await c.send("Target.closeTarget", { targetId: p.target });
    } else if (b.type === "resize") {
      p.state.width = b.width; p.state.height = b.height;
      await c.send("Emulation.setDeviceMetricsOverride", { width: b.width, height: b.height, deviceScaleFactor: 1, mobile: false }, p.session); this.emit(p); await this.snapshot(p);
    } else if (b.type === "mouse") {
      await c.send("Input.dispatchMouseEvent", { type: b.event, x: Math.min(b.x, p.state.width - 1), y: Math.min(b.y, p.state.height - 1), button: b.button, buttons: b.buttons, clickCount: b.clickCount, modifiers: b.modifiers, ...(b.event === "mouseWheel" ? { deltaX: b.deltaX ?? 0, deltaY: b.deltaY ?? 0 } : {}) }, p.session);
    } else if (b.type === "key") {
      await c.send("Input.dispatchKeyEvent", { type: b.event, key: b.key, code: b.code, windowsVirtualKeyCode: b.keyCode, nativeVirtualKeyCode: b.keyCode, modifiers: b.modifiers, text: b.text, unmodifiedText: b.text }, p.session);
    } else if (b.type === "text") await c.send("Input.insertText", { text: b.text }, p.session);
    else if (b.type === "dialog") await c.send("Page.handleJavaScriptDialog", { accept: b.accept, promptText: b.promptText }, p.session);
    else if (b.type === "copy") {
      // A user-requested selection only. Never expose passwords or accept arbitrary JS.
      const result = await c.send("Runtime.evaluate", { expression: `(()=>{const e=document.activeElement;if(e&&e.type==='password')return '';if(e&&(e.tagName==='INPUT'||e.tagName==='TEXTAREA')&&typeof e.selectionStart==='number')return e.value.slice(e.selectionStart,e.selectionEnd);return String(window.getSelection()||'')})()`, returnByValue: true }, p.session);
      return { text: String((result.result as Params)?.value ?? "").slice(0, 65536) };
    }
    return {};
  }
  async close(id: string) {
    const p = this.pages.get(id); if (!p) return;
    this.pages.delete(id); if (p.timer) clearTimeout(p.timer);
    for (const send of p.listeners) send({ type: "closed" });
    for (const target of [p.target, ...p.parents.map(parent => parent.target)]) await this.connection?.send("Target.closeTarget", { targetId: target }).catch(() => {});
  }
  async shutdown() {
    for (const id of [...this.pages.keys()]) await this.close(id);
    const c = this.connection; const child = this.child;
    this.connection = undefined; this.child = undefined;
    if (c) await c.send("Browser.close").catch(() => {});
    c?.close();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
const globalBrowser = globalThis as typeof globalThis & { __piBrowserManager?: BrowserManager };
export function getBrowserManager() { return globalBrowser.__piBrowserManager ??= new BrowserManager(); }
