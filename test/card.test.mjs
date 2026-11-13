import { test } from "node:test";
import assert from "node:assert/strict";
import { card, duration, figures } from "../src/card.mjs";

const m = {
  generated: "2026-11-30T12:00:00.000Z",
  windowDays: 3,
  deploys: 3,
  failed: 1,
  deploysPerWeek: 7,
  leadTimeHours: { median: 0.5, commits: 4 },
  changeFailureRate: 0.25,
  timeToRestoreHours: { median: 50, count: 1 },
  perDay: [
    { day: "2026-11-28", deploys: 0, failed: 0 },
    { day: "2026-11-29", deploys: 1, failed: 1 },
    { day: "2026-11-30", deploys: 2, failed: 0 },
  ],
};

test("durations read as minutes, hours or days", () => {
  assert.equal(duration(null), "–");
  assert.equal(duration(0.001), "1 min");
  assert.equal(duration(0.5), "30 min");
  assert.equal(duration(5.25), "5.3 h");
  assert.equal(duration(50), "2.1 days");
});

test("the figures and their small print", () => {
  const f = figures(m);
  assert.deepEqual(
    f.map((x) => [x.label, x.value, x.note]),
    [
      ["deploys", "3", "7.0 a week"],
      ["lead time", "30 min", "median of 4 commits"],
      ["change failure rate", "25%", "1 of 4"],
      ["time to restore", "2.1 days", "median of 1 incident"],
    ],
  );
});

test("the card escapes its title and differs by theme", () => {
  const dark = card(m, { title: "a&b <repo>", theme: "dark" });
  const light = card(m, { title: "a&b <repo>", theme: "light" });
  assert.match(dark, /^<svg [^>]*role="img"/);
  assert.match(dark, /<\/svg>\n$/);
  assert.ok(dark.includes("a&amp;b &lt;repo&gt;"));
  assert.ok(!dark.includes("<repo>"));
  assert.ok(dark.includes("#0d1117") && light.includes("#ffffff"));
  assert.match(dark, /<desc id="d">deploys: 3 \(7\.0 a week\); lead time: 30 min/);
  // One track per day, a bar for each day with deploys, and a red part for the failure.
  assert.equal((dark.match(/fill="#21262d"/g) ?? []).length, 3);
  assert.equal((dark.match(/fill="#f85149"/g) ?? []).length, 1);
});
