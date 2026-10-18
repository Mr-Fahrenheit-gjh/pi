import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findHandler(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") return node.initializer.arguments[0];
  return ts.forEachChild(node, findHandler);
}
const script = new Script(ts.transpileModule(findHandler(source).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
function press(key, overrides = {}, keys = {}) {
  const calls = [];
  const valueRef = {current: ""};
  const ctx = {
    Date: {now: () => 1000}, COMPOSITION_END_ENTER_GRACE_MS: 100,
    isMobile: false, isStreaming: false, enterSendMode: "enter", runningSendMode: "steer",
    isComposingRef: {current: false}, lastCompositionEndAtRef: {current: 0},
    historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
    slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
    atMenuOpen: false, atQuery: null, atMatches: [], atActiveIndex: 0,
    visiblePromptSuggestion: {text: "帮我运行测试", acceptTab: true}, valueRef, value: "",
    setValue(v) {calls.push(["value",v]);}, dismissPromptSuggestion() {calls.push(["dismiss"]);},
    onSteer() {}, onFollowUp() {}, onAbort() {calls.push(["abort"]);},
    handleSend() {calls.push(["send", valueRef.current]);}, sendQueued() {calls.push(["queue"]);},
    applySlashCommand() {calls.push(["slash"]);}, submitsSlashCommandOnEnter() {return false;},
    applyAtCompletion() {calls.push(["file"]);}, applyHistoryInput() {calls.push(["history"]);},
    setHistoryMenuOpen() {}, setSlashMenuOpen() {}, setAtMenuOpen() {},
    ...overrides,
  };
  script.runInNewContext(ctx)({key, shiftKey:false, ctrlKey:false, metaKey:false, altKey:false,
    nativeEvent: {isComposing:false,keyCode:0}, preventDefault() {calls.push(["prevent"]);}, ...keys});
  return {calls,valueRef};
}
test("Tab fills the suggestion without sending and Escape dismisses it", () => {
  const {calls,valueRef} = press("Tab");
  assert.deepEqual(calls, [["prevent"],["value","帮我运行测试"],["dismiss"]]);
  assert.equal(valueRef.current,"帮我运行测试");
  assert.deepEqual(press("Escape").calls,[["prevent"],["dismiss"]]);
});
test("Enter never accepts a ghost suggestion; modified Tab and IME stay native", () => {
  assert.deepEqual(press("Enter").calls,[["prevent"],["send",""]]);
  assert.deepEqual(press("Tab",{}, {shiftKey:true}).calls,[]);
  assert.deepEqual(press("Tab", {isComposingRef:{current:true}}).calls,[]);
  assert.deepEqual(press("Tab", {}, {nativeEvent:{isComposing:true,keyCode:229}}).calls,[]);
});
test("acceptTab:false preserves native Tab while Right Arrow can still accept", () => {
  const suggestion = {text:"帮我运行测试",acceptTab:false};
  assert.deepEqual(press("Tab",{visiblePromptSuggestion:suggestion}).calls,[]);
  assert.deepEqual(press("ArrowRight",{visiblePromptSuggestion:suggestion}).calls,[["prevent"],["value","帮我运行测试"],["dismiss"]]);
});
test("slash, file, and history completion retain precedence over suggestions", () => {
  assert.deepEqual(press("Tab",{slashMenuOpen:true,slashQuery:"help",displayedSlashCommands:[{name:"help"}]}).calls,[["prevent"],["slash"]]);
  assert.deepEqual(press("Tab",{atMenuOpen:true,atQuery:{},atMatches:[{}]}).calls,[["prevent"],["file"]]);
  assert.deepEqual(press("Tab",{historyMenuOpen:true,inputHistory:["prior"]}).calls,[["prevent"],["history"]]);
});
