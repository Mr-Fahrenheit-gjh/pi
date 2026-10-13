import assert from "node:assert/strict";
import test from "node:test";

const { streamRateKey, streamRateStart, streamTokensPerSecond } = await import("./stream-token-rate.ts");

const reply = (timestamp, model = "m") => ({ provider: "p", model, timestamp });

test("a reply's rate keeps its first-token start when the chat remounts", () => {
  const key = streamRateKey(reply(1_000));
  const start = streamRateStart(key, 20, 10_000);
  assert.equal(streamTokensPerSecond(start, 70, 11_000), 50);
  // A quick remount retains the measured interval, not a new zero-token start.
  const remounted = streamRateStart(key, 120, 12_000);
  assert.deepEqual(remounted, { at: 10_000, tokens: 20 });
  assert.equal(streamTokensPerSecond(remounted, 120, 12_000), 50);
  // A long absence cannot turn unseen historical output into fresh speed.
  assert.equal(streamTokensPerSecond(remounted, 1_520, 30_000), null);
  assert.equal(streamTokensPerSecond(remounted, 1_570, 31_000), 50);
});

test("joining a reply with no record times only the tokens that follow", () => {
  const start = streamRateStart(streamRateKey(reply(2_000)), 3_000, 50_000);
  assert.equal(streamTokensPerSecond(start, 3_000, 50_400), null);
  assert.equal(streamTokensPerSecond(start, 3_100, 51_000), 100);
});

test("replies are told apart by their request time and model", () => {
  assert.notEqual(streamRateKey(reply(3_000)), streamRateKey(reply(3_001)));
  assert.notEqual(streamRateKey(reply(3_000, "a")), streamRateKey(reply(3_000, "b")));
  assert.equal(streamRateKey({ provider: "p", model: "m" }), null);
  const unkeyed = streamRateStart(null, 10, 0);
  assert.notEqual(streamRateStart(null, 10, 0), unkeyed);
});

test("a complete first snapshot never reports zero speed", () => {
  const start = streamRateStart(null, 43, 0);
  assert.equal(streamTokensPerSecond(start, 43, 600), null);
  assert.equal(streamTokensPerSecond(start, 43, 10_000), null);
});

test("waiting does not dilute the measured speed and stale rates disappear", () => {
  const start = streamRateStart(null, 10, 0);
  assert.equal(streamTokensPerSecond(start, 60, 1000), 50);
  assert.equal(streamTokensPerSecond(start, 60, 1800), 50);
  assert.equal(streamTokensPerSecond(start, 60, 3100), null);
  assert.equal(streamTokensPerSecond(start, 80, 5000), null);
  assert.equal(streamTokensPerSecond(start, 130, 6000), 50);
});

test("answer and process have distinct sample baselines", () => {
  const message = reply(3500);
  const answerKey = streamRateKey(message, "answer");
  const processKey = streamRateKey(message, "process");
  assert.notEqual(answerKey, processKey);
  const process = streamRateStart(processKey, 500, 0);
  const answer = streamRateStart(answerKey, 10, 500);
  assert.equal(streamTokensPerSecond(process, 600, 1000), 100);
  assert.equal(streamTokensPerSecond(answer, 60, 1500), 50);
});

test("replacement counts, backwards clocks and non-finite samples are hidden", () => {
  const start = streamRateStart(null, 50, 1000);
  assert.equal(streamTokensPerSecond(start, 40, 1500), null);
  assert.equal(streamTokensPerSecond(start, 60, 1000), null);
  assert.equal(streamTokensPerSecond(start, Infinity, 2000), null);
  assert.equal(streamTokensPerSecond(start, 60, NaN), null);
  assert.equal(streamTokensPerSecond(start, 60, 2000), null);
});

test("rates that round to 0.0 are not displayed", () => {
  const start = streamRateStart(null, 1, 0);
  assert.equal(streamTokensPerSecond(start, 1.01, 1000), null);
});

test("only the newest replies are remembered", () => {
  const first = streamRateKey(reply(4_000));
  streamRateStart(first, 1, 0);
  for (let i = 1; i <= 32; i++) streamRateStart(streamRateKey(reply(4_000 + i)), 1, 0);
  assert.deepEqual(streamRateStart(first, 7, 99), { at: 99, tokens: 7 });
});
