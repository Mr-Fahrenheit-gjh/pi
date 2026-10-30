// Isolated fixture only: microphone, WebRTC, voice upstream and Pi submissions are mocked.
import assert from "node:assert/strict";
import { prepareWorkspaceFixture } from "./workspace-design.mjs";
export const prepareVoiceFixture = (agentDir) => prepareWorkspaceFixture(agentDir, { polishSibling: true });

export async function checkVoiceLayout(page, { outputDir } = {}) {
  const controls = page.getByTestId("voice-controls").first();
  await controls.waitFor();
  const boxes = await controls.evaluate((voice) => [voice.previousElementSibling, ...voice.querySelectorAll(":scope > button")].map((button) => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height };
  }));
  assert.equal(boxes.length, 3, "Attachment, dictation and live call are separate controls");
  for (const box of boxes) {
    assert.equal(box.width, 32); assert.equal(box.height, 32);
    assert.ok(Math.abs(box.y - boxes[0].y) < 1, "The three icons share a baseline");
  }
  const gaps = boxes.slice(1).map((box, i) => box.x - boxes[i].x - boxes[i].width);
  for (const gap of gaps) assert.ok(Math.abs(gap - 12) < 1, "Each button has the same generous gap");
  if (outputDir) await page.locator(".chat-input-shell").first().screenshot({ path: `${outputDir}/voice-controls.png` });
  return { buttonSize: 32, gaps };
}

export async function runVoiceChecks(page, { baseURL, sessionId = "workspace-design-fixture", outputDir }) {
  assert.notEqual(new URL(baseURL).port, "30141", "Never mock the formal user page");
  const errors = [], prompts = [], handoffs = [], calls = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let operation = null, deferTranscribe = false, finishTranscribe, transcriptions = 0;
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-ui-language-version", "english-interface-v1"); localStorage.setItem("pi-sidebar-open", "true");
    localStorage.setItem("pi-theme", "claude-white");
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    const fixture = window.__voice = { tracks: [], peers: [], sources: [], contexts: [], amplitude: 0, permission: null, captures: 0 };
    window.AudioContext = class {
      state = "running";
      constructor() { fixture.contexts.push(this); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createAnalyser() { return { fftSize: 512, getByteTimeDomainData(data) { data.fill(128 + fixture.amplitude); }, disconnect() {} }; }
      close() { this.state = "closed"; return Promise.resolve(); }
    };
    const stream = () => { const track = { enabled: true, stopped: false, stop() { this.stopped = true; } }; fixture.tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => { fixture.captures++; return fixture.permission ? new Promise((resolve) => { fixture.resolvePermission = () => resolve(stream()); }) : Promise.resolve(stream()); } } });
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
      state = "inactive"; mimeType = "audio/webm;codecs=opus";
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["fixture audio"], { type: this.mimeType }) }); this.onstop?.(); }); }
    };
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = "complete"; connectionState = "connected"; localDescription = null; closed = false;
      constructor() { super(); fixture.peers.push(this); }
      createDataChannel() { this.channel = { readyState: "open", sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() { this.readyState = "closed"; } }; return this.channel; }
      addTrack() {}
      async createOffer() { if (!this.channel.onmessage || !this.ontrack) throw new Error("Listeners must precede offer"); return { type: "offer", sdp: "v=0\r\noffer" }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription() {}
      close() { this.closed = true; }
    };
    fixture.event = (event) => fixture.peers.at(-1)?.channel.onmessage?.({ data: JSON.stringify(event) });
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2; readyState = 1;
      constructor(url) { super(); this.url = url; fixture.sources.push(this); setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }), 0); }
      close() { this.readyState = 2; }
    };
  });
  const state = { isStreaming: false, isPromptRunning: false, isCompacting: false, model: { provider: "openai", id: "fixture" }, messages: [], extensionStatuses: [], extensionWidgets: [] };
  await page.route("**/api/agent/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.type === "prompt") prompts.push(body);
      if (body.type === "get_tools") return route.fulfill({ json: { success: true, data: [] } });
      if (body.type === "get_commands") return route.fulfill({ json: { success: true, data: { commands: [] } } });
      return route.fulfill({ json: { success: true, data: state } });
    }
    return route.fulfill({ json: request.url().includes("/running") ? { runningSessionIds: [], awaitingInputSessionIds: [] } : { running: false, state } });
  });
  await page.route("**/api/sessions/*/state", (route) => route.fulfill({ json: { running: false, state } }));
  await page.route("**/api/models?**", (route) => route.fulfill({ json: { models: {}, modelList: [] } }));
  await page.route("**/api/chat-attachments", (route) => route.fulfill({ json: { attachments: [{ name: "voice-note.txt", path: `/tmp/voice-fixture/chat-attachments/${"a".repeat(64)}/voice-note.txt` }] } }));
  await page.route("**/api/voice/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "transcribe") {
      transcriptions++;
      assert.match(route.request().headers()["content-type"], /^audio\/webm/);
      if (deferTranscribe) await new Promise((resolve) => { finishTranscribe = resolve; });
      return route.fulfill({ json: { text: "dictated words" } }).catch(() => {});
    }
    const body = route.request().postDataJSON(); calls.push({ action, body });
    if (action === "start") return route.fulfill({ json: { token: "fixture-token", liveId: "live_fixture", leafId: "fixture-leaf", sdp: "v=0\r\nanswer" } });
    if (action === "handoff") { handoffs.push(body); operation = { id: body.delegationId, status: "running" }; return route.fulfill({ json: { operation } }); }
    if (action === "poll") return route.fulfill({ json: { operation } });
    return route.fulfill({ json: { ended: true } });
  });
  const event = (e) => page.evaluate((value) => window.__voice.event(value), e);
  const input = page.locator(".chat-input-textarea").first();
  const startCall = async () => {
    const polled = page.waitForResponse((response) => response.url().endsWith("/api/voice/poll"));
    await page.getByRole("button", { name: "Call Pi Live", exact: true }).first().click();
    await page.waitForFunction(() => window.__voice.peers.at(-1)?.localDescription);
    await polled;
    await event({ type: "session.started" });
    await page.getByRole("button", { name: "Mute mic", exact: true }).waitFor({ state: "visible" });
  };
  await page.goto(`${baseURL}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  await input.waitFor();
  assert.equal(await page.getByTestId("voice-controls").count(), 1);
  const layout = await checkVoiceLayout(page, { outputDir });
  await page.locator('.chat-input-shell input[type="file"]').first().setInputFiles({ name: "voice-note.txt", mimeType: "text/plain", buffer: Buffer.from("fixture attachment") });
  const card = page.locator(".chat-input-shell .attachment-card"); await card.waitFor();
  await input.fill("existing draft");
  await page.getByRole("button", { name: "Dictate to draft", exact: true }).click();
  await page.getByRole("button", { name: "Stop and transcribe", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.voice-inline[data-mode="recording"]'));
  assert.equal(await input.isVisible(), false, "Recording replaces the draft surface, not a floating popup");
  assert.equal(await page.locator('.composer-surface .voice-capture-row').count(), 1);
  assert.equal(await page.locator('.voice-panel, .voice-inline [role="dialog"]').count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.voice-waveform span')].every((bar) => parseFloat(bar.style.height) === 3));
  await page.evaluate(() => { window.__voice.amplitude = 16; });
  await page.waitForFunction(() => [...document.querySelectorAll('.voice-waveform span')].some((bar) => parseFloat(bar.style.height) > 3));
  if (outputDir) await page.locator('.chat-input-shell').first().screenshot({ path: `${outputDir}/voice-recording.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const inlineMobile = await page.locator('.voice-capture-row').evaluate((row) => {
    const box = row.getBoundingClientRect();
    return { width: box.width, right: box.right, scroll: row.scrollWidth, client: row.clientWidth };
  });
  assert.ok(inlineMobile.right <= 390 && inlineMobile.scroll <= inlineMobile.client, "Inline recording fits mobile without clipping its actions");
  if (outputDir) await page.locator('.chat-input-shell').first().screenshot({ path: `${outputDir}/voice-recording-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'visible' });
  assert.equal(await input.inputValue(), 'existing draft'); assert.equal(transcriptions, 0, "Cancel never transcribes or sends");
  assert.ok(await page.evaluate(() => window.__voice.contexts.every((context) => context.state === 'closed')));
  await page.getByRole("button", { name: "Dictate to draft", exact: true }).click();
  await page.getByRole("button", { name: "Stop and transcribe", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".chat-input-textarea")?.value === "existing draft dictated words");
  await input.waitFor({ state: 'visible' });
  assert.equal(prompts.length, 0); assert.equal(await card.count(), 1);

  await startCall();
  assert.equal(await page.locator('.composer-surface .voice-capture-row').count(), 1);
  assert.equal(await page.locator('.voice-call-details').getAttribute('open'), null, 'Call details stay collapsed until requested');
  await event({ type: "session.input_transcript.delta", event_id: "u1", delta: "inspect the current task", start_ms: 1, end_ms: 10 });
  const delegation = { type: "session.delegation.created", event_id: "d-event", offset_ms: 12, delegation: { id: "d1", target: "client" } };
  await event(delegation); await event(delegation);
  const task = page.getByRole("textbox", { name: "Request for current Pi session", exact: true }); await task.waitFor();
  assert.equal(handoffs.length, 0); assert.equal(await task.inputValue(), "inspect the current task");
  await task.fill("inspect without changing files");
  await page.getByRole("button", { name: "Hand to Pi", exact: true }).dblclick();
  await page.waitForFunction(() => document.querySelector(".voice-inline")?.textContent.includes("Pi accepted the request"));
  assert.equal(handoffs.length, 1); assert.equal(handoffs[0].sessionId, sessionId);
  assert.equal(handoffs[0].text, "inspect without changing files");
  operation = { id: "unrelated", status: "completed", text: "WRONG ANSWER" };
  await page.waitForResponse((response) => response.url().endsWith("/api/voice/poll"));
  assert.equal(await page.evaluate(() => window.__voice.peers.at(-1).channel.sent.some((e) => e.content === "WRONG ANSWER")), false);
  operation = { id: "d1", status: "completed", text: "Matched Pi final answer", leafId: "next-leaf" };
  await page.waitForFunction(() => window.__voice.peers.at(-1).channel.sent.some((e) => e.content === "Matched Pi final answer"));
  await page.waitForResponse((response) => response.url().endsWith("/api/voice/poll"));
  assert.equal(await page.evaluate(() => window.__voice.peers.at(-1).channel.sent.filter((e) => e.content === "Matched Pi final answer").length), 1);
  assert.equal(await input.inputValue(), "existing draft dictated words"); assert.equal(await card.count(), 1);
  await page.getByRole("button", { name: "Mute mic", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__voice.tracks.at(-1).enabled), false);
  if (outputDir) await page.screenshot({ path: `${outputDir}/voice.png` });
  const revoked = page.waitForRequest((request) => request.url().endsWith("/api/voice/revoke"));
  await page.getByRole("button", { name: "Hang up", exact: true }).click(); await revoked;
  await input.waitFor({ state: "visible" });
  assert.equal(await page.locator(".voice-capture-row").count(), 0, "End restores the draft without waiting for remote usage");
  assert.equal(await page.evaluate(() => window.__voice.tracks.every((track) => track.stopped)), true);
  assert.equal(await page.evaluate(() => window.__voice.peers.at(-1).closed), false);
  await event({ type: "session.closed", usage: { seconds: 12 } });
  await page.waitForFunction(() => window.__voice.peers.at(-1).closed && window.__voice.tracks.every((t) => t.stopped));
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();

  // Leaving a live call closes only voice, not an already admitted Pi operation.
  await startCall();
  await page.locator(".sidebar-quick-new:visible, .sidebar-new-button:visible").first().click();
  await page.waitForFunction(() => window.__voice.peers.at(-1).channel.sent.some((e) => e.type === "session.close"));
  await event({ type: "session.closed", usage: { seconds: 1 } });
  assert.equal(await page.evaluate(() => window.__voice.tracks.every((t) => t.stopped)), true);
  await page.locator(`a.session-tree-main[href="?session=${sessionId}"]`).first().click();
  await input.waitFor();
  // A late recording response must not cross the actual SPA New navigation boundary.
  deferTranscribe = true;
  await page.getByRole("button", { name: "Dictate to draft", exact: true }).click();
  const transcribing = page.waitForRequest((request) => request.url().endsWith("/api/voice/transcribe"));
  await page.getByRole("button", { name: "Stop and transcribe", exact: true }).click();
  await transcribing;
  await page.locator(".sidebar-quick-new:visible, .sidebar-new-button:visible").first().click();
  await page.waitForFunction(() => !document.querySelector(".conversation-transition")?.hasAttribute("inert") && document.querySelector(".chat-input-textarea")?.placeholder === "How can I help you today?");
  await input.fill("replacement draft"); finishTranscribe?.();
  await page.getByRole("button", { name: "Call Pi Live", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Call Pi Live", exact: true }).isDisabled(), true);
  assert.equal(await input.inputValue(), "replacement draft");
  assert.equal(prompts.length, 0, "No voice event may accidentally use the main prompt route");
  await page.locator(`a.session-tree-main[href="?session=${sessionId}"]`).first().click();
  await input.waitFor();
  // Both split composers stay mounted: active-pane changes must transfer microphone ownership.
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".quick-actions-backdrop input").fill("split");
  await page.getByRole("option", { name: /Split conversation/ }).click();
  const left = page.locator(".primary-conversation"), right = page.locator(".secondary-conversation");
  await right.getByRole("button", { name: /New conversation/ }).click();
  const otherInput = right.locator(".chat-input-textarea"); await otherInput.waitFor();
  for (const name of ["Dictate to draft", "Call Pi Live"]) {
    await input.click();
    await page.evaluate(() => { window.__voice.permission = true; window.__voice.resolvePermission = null; });
    await left.getByRole("button", { name, exact: true }).click();
    await page.waitForFunction(() => typeof window.__voice.resolvePermission === "function");
    await otherInput.click();
    await page.evaluate(() => { window.__voice.resolvePermission(); window.__voice.permission = null; });
    await page.waitForFunction(() => window.__voice.tracks.every((track) => track.stopped));
    assert.equal(await left.getByRole("button", { name: "Dictate to draft", exact: true }).isDisabled(), true);
  }
  await input.click();
  await left.getByRole("button", { name: "Dictate to draft", exact: true }).click();
  await left.getByRole("button", { name: "Stop and transcribe", exact: true }).waitFor();
  await otherInput.click();
  await page.waitForFunction(() => window.__voice.tracks.every((track) => track.stopped));
  await input.click(); await startCall();
  const splitRevoke = page.waitForRequest((request) => request.url().endsWith("/api/voice/revoke"));
  await otherInput.click(); await splitRevoke;
  await event({ type: "session.closed", usage: { seconds: 1 } });
  await page.waitForFunction(() => window.__voice.tracks.every((track) => track.stopped));
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".quick-actions-backdrop input").fill("split");
  await page.getByRole("option", { name: /Close split/ }).click();
  assert.equal(prompts.length, 0);
  const sent = page.waitForRequest((request) => request.method() === "POST" && request.url().includes("/api/agent/") && request.postDataJSON()?.type === "prompt");
  await input.press("Enter"); await sent;
  assert.equal(prompts.length, 1, "Only the explicit keyboard send submits the draft");
  assert.deepEqual(errors, []);
  return { passed: true, layout, inlineCapture: true, mobileCapture: true, measuredWaveform: true, cancelPreservesDraft: true, inlineCall: true, draftOnly: true, attachmentsPreserved: true, confirmedHandoff: true, matchedCompletion: true, deduplicated: true, cleanup: true, navigation: true, splitOwnership: true, legacyAbortSignals: true };
}

// Explicit opt-in paid transport probe. Use a synthetic session and audio only;
// it exercises the actual candidate routes/client without requesting a microphone.
export async function runVoiceProductChecks(page, { baseURL, sessionId, audioBase64 }) {
  assert.notEqual(new URL(baseURL).port, "30141", "Use an isolated candidate");
  await page.addInitScript(() => {
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-ui-language-version", "english-interface-v1");
    window.__voiceProduct = { streams: [], contexts: [] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      window.__voiceProduct.contexts.push(context); window.__voiceProduct.streams.push(destination.stream);
      return destination.stream;
    } } });
  });
  await page.goto(`${baseURL}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async (audio) => {
    const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
    const response = await fetch("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: bytes });
    return { status: response.status, data: await response.json() };
  }, audioBase64);
  assert.equal(result.status, 200); assert.match(result.data.text, /voice input test/i);
  const started = page.waitForResponse((response) => response.url().endsWith("/api/voice/start"), { timeout: 65_000 });
  let call;
  try {
    await page.getByRole("button", { name: "Call Pi Live", exact: true }).click();
    const response = await started; assert.equal(response.status(), 200); call = await response.json();
    await page.getByRole("button", { name: "Mute mic", exact: true }).click({ trial: true, timeout: 45_000 });
    const revoked = page.waitForResponse((response) => response.url().endsWith("/api/voice/revoke"));
    const ended = page.waitForResponse((response) => response.url().endsWith("/api/voice/end"), { timeout: 20_000 });
    await page.getByRole("button", { name: "Hang up", exact: true }).click();
    assert.equal((await revoked).status(), 200);
    const endResponse = await ended;
    assert.equal(endResponse.status(), 200);
    assert.equal(endResponse.request().postDataJSON().confirmed, true, "Native session.closed must confirm remote close");
    await page.waitForFunction(() => window.__voiceProduct.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
    const running = await page.request.get(`${baseURL}/api/agent/running`);
    assert.equal(running.ok(), true);
    const ids = (await running.json()).otherRuntimeRunningSessionIds;
    assert.equal(Array.isArray(ids), true, "Restart accounting must be present");
    assert.equal(ids.includes("voice:active"), false, "Confirmed close releases the restart blocker");
    return { passed: true, syntheticAudio: true, transcription: result.data.text, nativeLiveStarted: true, remoteCloseConfirmed: true, tracksEnded: true, restartReleased: true, realPiHandoff: false };
  } finally {
    const hangup = page.getByRole("button", { name: "Hang up", exact: true });
    if (await hangup.isVisible().catch(() => false)) await hangup.click().catch(() => {});
    await page.evaluate(async () => {
      window.__voiceProduct.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      await Promise.all(window.__voiceProduct.contexts.map((context) => context.close()));
    }).catch(() => {});
    // No forged confirmed closure on failures: server conservatively retains its blocker.
    if (call) await page.request.post(`${baseURL}/api/voice/revoke`, { headers: { Origin: baseURL }, data: { ...call, sessionId } }).catch(() => {});
  }
}

export async function checkVoice({ browser, base, artifacts, sessionId }) {
  const context = await browser.newContext();
  try { const page = await context.newPage(); const result = await runVoiceChecks(page, { baseURL: base, outputDir: artifacts, sessionId }); console.log("PASS: voice", JSON.stringify(result)); }
  finally { await context.close(); }
}
