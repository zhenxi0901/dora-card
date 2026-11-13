import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, median, outcomeOf } from "../src/dora.mjs";

const at = (s) => new Date(`2026-11-${s}Z`);
const now = at("30T12:00:00");
const nothing = async () => [];

// Ten days to 30 Nov noon: the window opens 20 Nov noon.
const runs = [
  { id: 0, sha: "a0", ended: at("18T10:00:00"), outcome: "deploy" }, // before the window: the baseline
  { id: 1, sha: "a1", ended: at("21T10:00:00"), outcome: "deploy" },
  { id: 2, sha: "a2", ended: at("23T10:00:00"), outcome: "failed" },
  { id: 3, sha: "a3", ended: at("23T12:00:00"), outcome: "deploy" }, // restored 2 h after the failure
  { id: 4, sha: "a4", ended: at("24T09:00:00"), outcome: null }, // cancelled: not a deploy
  { id: 5, sha: "a3", ended: at("25T09:00:00"), outcome: "deploy" }, // a redeploy: ships nothing new
];
const commits = {
  "a0...a1": [{ sha: "c1", at: at("21T08:00:00") }], // 2 h
  "a1...a3": [
    { sha: "c0", at: at("19T12:00:00") }, // committed before the window, shipped in it: counted, 96 h
    { sha: "c2", at: at("22T12:00:00") }, // 24 h
    { sha: "c3", at: at("23T11:00:00") }, // 1 h
  ],
};
const added = async (base, head) => commits[`${base}...${head}`] ?? assert.fail(`unexpected compare ${base}...${head}`);

test("outcomes: success deploys, failure and timeout fail, the rest are not deploys", () => {
  assert.equal(outcomeOf("success"), "deploy");
  assert.equal(outcomeOf("failure"), "failed");
  assert.equal(outcomeOf("timed_out"), "failed");
  for (const c of ["cancelled", "skipped", "neutral", "action_required", "startup_failure", null]) assert.equal(outcomeOf(c), null);
});

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("the four metrics over a window", async () => {
  const m = await measure({ runs, added, now, windowDays: 10 });
  assert.equal(m.deploys, 3);
  assert.equal(m.failed, 1);
  assert.equal(m.changeFailureRate, 0.25);
  assert.ok(Math.abs(m.deploysPerWeek - 2.1) < 1e-9);
  assert.deepEqual(m.leadTimeHours, { median: 13, commits: 4 }); // 1, 2, 24 and 96 h
  assert.deepEqual(m.timeToRestoreHours, { median: 2, count: 1 });
  // A bar per UTC day, from the day the window opens (at noon) to today.
  assert.equal(m.perDay.length, 11);
  assert.equal(m.perDay[0].day, "2026-11-20");
  assert.deepEqual(m.perDay.find((d) => d.day === "2026-11-23"), { day: "2026-11-23", deploys: 1, failed: 1 });
  assert.equal(m.perDay.at(-1).day, "2026-11-30");
});

test("a deploy in the window that ships only old commits still has a lead time", async () => {
  const slow = [
    { id: 1, sha: "b1", ended: at("01T10:00:00"), outcome: "deploy" },
    { id: 2, sha: "b2", ended: at("29T10:00:00"), outcome: "deploy" },
  ];
  const m = await measure({ runs: slow, added: async () => [{ sha: "c1", at: at("15T10:00:00") }], now, windowDays: 10 });
  assert.deepEqual(m.leadTimeHours, { median: 14 * 24, commits: 1 });
});

test("a commit is counted once, by the deploy that first shipped it, whichever comparison answers first", async () => {
  const twice = {
    "a0...a1": [{ sha: "c1", at: at("21T08:00:00") }],
    "a1...a3": [
      { sha: "c1", at: at("21T08:00:00") },
      { sha: "c2", at: at("22T12:00:00") },
    ],
  };
  // The comparisons are asked for together, and the first deploy's answers last.
  let asked = 0;
  let together = 0;
  const slowFirst = async (b, h) => {
    together = Math.max(together, ++asked);
    await new Promise((resolve) => setTimeout(resolve, h === "a1" ? 20 : 1));
    asked--;
    return twice[`${b}...${h}`] ?? [];
  };
  const m = await measure({ runs, added: slowFirst, now, windowDays: 10 });
  assert.equal(together, 2);
  assert.deepEqual(m.leadTimeHours, { median: 13, commits: 2 }); // c1 by a1 (2 h), c2 by a3 (24 h)
});

test("consecutive failures are one incident, timed from the first; the failure rate counts each", async () => {
  const streak = [
    { id: 1, sha: "b1", ended: at("22T10:00:00"), outcome: "deploy" },
    { id: 2, sha: "b2", ended: at("23T10:00:00"), outcome: "failed" },
    { id: 3, sha: "b3", ended: at("23T11:00:00"), outcome: "failed" },
    { id: 4, sha: "b3", ended: at("23T11:30:00"), outcome: null }, // cancelled: neither ends the incident nor counts
    { id: 5, sha: "b4", ended: at("23T12:00:00"), outcome: "deploy" },
  ];
  const m = await measure({ runs: streak, added: nothing, now, windowDays: 10 });
  assert.equal(m.failed, 2);
  assert.equal(m.changeFailureRate, 0.5);
  assert.deepEqual(m.timeToRestoreHours, { median: 2, count: 1 }); // one 2 h outage, not 2 h and 1 h
});

test("an incident that began before the window is timed from its first failure", async () => {
  const straddle = [
    { id: 1, sha: "b1", ended: at("19T10:00:00"), outcome: "deploy" },
    { id: 2, sha: "b2", ended: at("20T10:00:00"), outcome: "failed" }, // before the window opens at noon
    { id: 3, sha: "b3", ended: at("20T13:00:00"), outcome: "failed" },
    { id: 4, sha: "b4", ended: at("20T14:00:00"), outcome: "deploy" },
  ];
  const m = await measure({ runs: straddle, added: nothing, now, windowDays: 10 });
  assert.equal(m.failed, 1);
  assert.deepEqual(m.timeToRestoreHours, { median: 4, count: 1 });
});

test("a deploy in the window's first, partial day has a bar", async () => {
  const early = [{ id: 1, sha: "b1", ended: at("20T13:00:00"), outcome: "deploy" }];
  const m = await measure({ runs: early, added: nothing, now, windowDays: 10 });
  assert.equal(m.deploys, 1);
  assert.deepEqual(m.perDay[0], { day: "2026-11-20", deploys: 1, failed: 0 });
  assert.equal(m.perDay.reduce((n, d) => n + d.deploys, 0), 1);
});

test("a failure not yet restored has no restore time", async () => {
  const open = [...runs.filter((r) => r.id < 2), { id: 9, sha: "a9", ended: at("29T10:00:00"), outcome: "failed" }];
  const m = await measure({ runs: open, added, now, windowDays: 10 });
  assert.equal(m.failed, 1);
  assert.deepEqual(m.timeToRestoreHours, { median: null, count: 0 });
});

test("nothing to measure", async () => {
  const m = await measure({ runs: [], added, now, windowDays: 30 });
  assert.equal(m.deploys, 0);
  assert.equal(m.changeFailureRate, null);
  assert.equal(m.leadTimeHours.median, null);
  assert.equal(m.perDay.length, 31);
});
