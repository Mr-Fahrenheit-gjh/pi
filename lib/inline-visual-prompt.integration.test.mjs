import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxProvider, fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { bindInlineVisualPrompt, createInlineVisualExtension, updateInlineVisualPreference } = await jiti.import("./inline-visual-prompt.ts");
const { createExactSystemPromptExtension } = await jiti.import("./exact-system-prompt.ts");

for (const chatOnly of [false, true]) {
  test(`diagram preference reaches queued SDK turns without altering the transcript (${chatOnly ? "Chat-only" : "normal"})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "pi-inline-visual-prompt-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const preference = { enabled: true };
    const faux = fauxProvider({ models: [{ id: "visual-test" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, noSkills: true,
        extensionFactories: [createInlineVisualExtension(preference), ...(chatOnly ? [createExactSystemPromptExtension(() => "CHAT_ONLY_BASE")] : [])],
      },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("visual-test"), tools: [] });
    t.after(() => session.dispose());
    bindInlineVisualPrompt(session.agent, preference);
    await session.bindExtensions({});
    const prompts = [];
    faux.setResponses([
      async context => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        updateInlineVisualPreference(preference, "follow_up", false);
        await session.followUp("queued while disabled");
        return fauxAssistantMessage("first answer");
      },
      async context => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        updateInlineVisualPreference(preference, "steer", true);
        await session.steer("queued while enabled");
        return fauxAssistantMessage("second answer");
      },
      context => { prompts.push(getCurrentSystemPrompt(context.messages)); return fauxAssistantMessage("third answer"); },
    ]);
    await session.prompt("original question", { source: "rpc" });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /inline diagrams are enabled/);
    assert.match(prompts[1], /switched off/);
    assert.doesNotMatch(prompts[1], /inline diagrams are enabled/);
    assert.match(prompts[2], /inline diagrams are enabled/);
    assert.doesNotMatch(prompts[2], /switched off/);
    for (const prompt of prompts) {
      if (chatOnly) { assert.ok(prompt.startsWith("CHAT_ONLY_BASE")); assert.doesNotMatch(prompt, /You are an expert coding assistant/); }
    }
    const messages = session.messages.filter(message => message.role === "user");
    assert.deepEqual(messages.map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("")), ["original question", "queued while disabled", "queued while enabled"]);
    assert.ok(!JSON.stringify(session.messages).includes("Pi Web inline diagrams"), "Request-local instructions must not contaminate saved messages");
  });
}
