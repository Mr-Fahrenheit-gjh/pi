import assert from "node:assert/strict";
import test from "node:test";
import { getQuestionnaire, presentQuestionOption, presentQuestionTitle } from "./question-presentation.ts";

test("separates the RPC option's title, description and recommendation", () => {
  const raw = "1. 继续精修 (Recommended) — 保留主题，完善细节。";
  assert.deepEqual(presentQuestionOption(raw, 0), {
    number: "1", label: "继续精修", description: "保留主题，完善细节。", recommendation: "Recommended",
  });
  assert.equal(raw, "1. 继续精修 (Recommended) — 保留主题，完善细节。");
});

test("keeps full descriptions and localized recommendation labels", () => {
  assert.deepEqual(presentQuestionOption("2. 再看看（推荐） — 第一行 — 后续说明\n第二行", 1), {
    number: "2", label: "再看看", description: "第一行 — 后续说明\n第二行", recommendation: "推荐",
  });
  assert.equal(presentQuestionOption("1. 再看看（推薦） — 說明", 0).recommendation, "推薦");
});

test("supports the numbered free-answer row without inventing a description", () => {
  assert.deepEqual(presentQuestionOption("3. Type something.", 2), {
    number: "3", label: "Type something.", description: null, recommendation: null,
  });
});

test("preserves generic options and Markdown rather than guessing their structure", () => {
  for (const raw of ["普通选项 — 一段文字", "3. 不同编号 — 说明", "1. **粗体 — 标题**", "1. \x60a — b\x60", "Option\nDetails"]) {
    assert.deepEqual(presentQuestionOption(raw, 0), {
      number: null, label: raw, description: null, recommendation: null,
    });
  }
});

test("separates the question's meaningful category and supporting paragraphs", () => {
  assert.deepEqual(presentQuestionTitle("[界面优化] 下一步怎么继续？\n\n保留主题。\n\n保留文件。"), {
    category: "界面优化", heading: "下一步怎么继续？", detail: "保留主题。\n\n保留文件。",
  });
});

const options = ["1. One — First", "2. Two — Second"];
const select = { id: "s", method: "select", title: "[Choice] Pick one", options: [...options, "3. Type something."] };
const input = { id: "i", method: "input", title: `${select.title}\n\n${options.join("\n")}\n\nType your answer:` };

test("recognizes only canonical numbered questionnaire selects and hides the sentinel", () => {
  const model = getQuestionnaire(select);
  assert.deepEqual(model.options, options);
  assert.equal(model.other, "3. Type something.");
  assert.equal(getQuestionnaire({ ...select, options: ["One", "Two", "Type something."] }), null);
  assert.equal(getQuestionnaire({ ...select, options: [...options, "3. 自己补充想法"] }), null);
  assert.ok(getQuestionnaire({ ...select, options: [...options, "3. 输入内容"] }));
});

test("reconstructs the same question for canonical input without changing raw wire titles", () => {
  const model = getQuestionnaire(select);
  assert.equal(getQuestionnaire(input, model), model);
  assert.equal(getQuestionnaire(input).key, model.key);
  assert.equal(getQuestionnaire(input).title, select.title);
  assert.equal(getQuestionnaire({ ...input, title: input.title + " extra" }, model), null);
  assert.equal(getQuestionnaire({ ...input, title: "Free input" }, model), null);
  assert.equal(input.title.endsWith("Type your answer:"), true);
  assert.equal(getQuestionnaire({ ...input, title: input.title.replace("Type your answer:", "输入你的回答：") }).key, model.key);
});

test("removes only canonical preview blocks from the matching stem", () => {
  const model = getQuestionnaire({ ...select, title: select.title + "\n\n--- 1. One preview ---\nExample" });
  assert.equal(model.title.endsWith("Example"), true);
  assert.equal(model.stem, select.title);
  assert.equal(getQuestionnaire(input, model), model);
});

test("keeps multiline headings, plain titles and bracketed literals", () => {
  assert.deepEqual(presentQuestionTitle("第一行\n第二行"), {
    category: null, heading: "第一行\n第二行", detail: null,
  });
  assert.equal(presentQuestionTitle("[literal]").heading, "[literal]");
  assert.deepEqual(presentQuestionTitle("\n\n问题\n\n说明\n"), {
    category: null, heading: "问题", detail: "说明",
  });
  assert.deepEqual(presentQuestionTitle("问题\r\n\r\n说明"), {
    category: null, heading: "问题", detail: "说明",
  });
});
