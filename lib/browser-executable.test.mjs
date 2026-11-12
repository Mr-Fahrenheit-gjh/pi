import assert from "node:assert/strict";
import test from "node:test";
import { chromeExecutableCandidates } from "./browser-executable.ts";

test("Windows discovers system and per-user Chrome without a shell", () => {
  assert.deepEqual(chromeExecutableCandidates("win32", {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\Alice Smith\\AppData\\Local",
  }), [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\Alice Smith\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
});

test("explicit Chrome path comes first and duplicate candidates collapse", () => {
  const executable = "D:\\Browser Tools\\chrome.exe";
  assert.equal(chromeExecutableCandidates("win32", { PI_WEB_CHROME_EXECUTABLE: executable })[0], executable);
  const root = "C:\\Program Files";
  assert.deepEqual(chromeExecutableCandidates("win32", { ProgramFiles: root, "ProgramFiles(x86)": root }), [
    `${root}\\Google\\Chrome\\Application\\chrome.exe`,
  ]);
  assert.deepEqual(chromeExecutableCandidates("win32", {}), []);
});

test("macOS and Linux retain native Chrome locations", () => {
  assert.deepEqual(chromeExecutableCandidates("darwin", {}), ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  const linux = chromeExecutableCandidates("linux", { PI_WEB_CHROME_EXECUTABLE: "/custom/chrome" });
  assert.equal(linux[0], "/custom/chrome");
  assert.ok(linux.includes("/usr/bin/google-chrome"));
  assert.ok(linux.includes("/usr/bin/chromium"));
  assert.ok(linux.includes("/snap/bin/chromium"));
  assert.ok(!linux.some(path => path.includes("/Applications/")));
});
