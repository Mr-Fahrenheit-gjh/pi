import assert from "node:assert/strict";
import test from "node:test";
import { readUiLocale, UI_LOCALE_STORAGE_KEY, UI_LOCALE_MIGRATION_KEY, UI_LOCALE_VERSION } from "./preference.ts";

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const writes = [];
  return { data, writes, getItem: key => data.get(key) ?? null, setItem(key, value) { writes.push(key); data.set(key, value); } };
}

test("new and legacy browser preferences migrate once to the requested English interface", () => {
  for (const locale of [undefined, "zh-CN", "zh-TW", "en"]) {
    const s = storage({ ...(locale ? { [UI_LOCALE_STORAGE_KEY]: locale } : {}), draft: "中文草稿", todos: "中文任务" });
    assert.equal(readUiLocale(s), "en");
    assert.equal(s.getItem(UI_LOCALE_STORAGE_KEY), "en");
    assert.equal(s.getItem(UI_LOCALE_MIGRATION_KEY), UI_LOCALE_VERSION);
    assert.deepEqual(s.writes, [UI_LOCALE_STORAGE_KEY, UI_LOCALE_MIGRATION_KEY]);
    assert.equal(s.getItem("draft"), "中文草稿");
    assert.equal(s.getItem("todos"), "中文任务");
  }
});

test("later explicit language selections remain intact, without repeated migration writes", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const s = storage({ [UI_LOCALE_MIGRATION_KEY]: UI_LOCALE_VERSION, [UI_LOCALE_STORAGE_KEY]: locale });
    assert.equal(readUiLocale(s), locale);
    assert.deepEqual(s.writes, []);
  }
});

test("unavailable or partially failing storage keeps English without touching content", () => {
  for (const failAt of ["get", "locale", "version"]) {
    const s = storage({ draft: "保留原文" });
    if (failAt === "get") s.getItem = () => { throw new Error("Storage denied"); };
    else { const write = s.setItem.bind(s); s.setItem = (key, value) => { if (key === (failAt === "locale" ? UI_LOCALE_STORAGE_KEY : UI_LOCALE_MIGRATION_KEY)) throw new Error("Quota"); write(key, value); }; }
    assert.equal(readUiLocale(s), "en");
    assert.equal(s.data.get("draft"), "保留原文");
  }
  assert.equal(readUiLocale(storage({ [UI_LOCALE_MIGRATION_KEY]: UI_LOCALE_VERSION, [UI_LOCALE_STORAGE_KEY]: "bad" })), "en");
});
