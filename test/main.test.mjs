import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client } from "../src/github.mjs";
import { run } from "../src/main.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the client pages until a short page or until it has enough", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return json({ items: Array.from({ length: page < 3 ? 100 : 7 }, (_, i) => ({ n: (page - 1) * 100 + i })) });
  };
  const gh = client({ repository: "o/r", token: "t", fetchImpl });
  assert.equal((await gh.list("/x?a=1", "items")).length, 207);
  assert.equal(seen.length, 3);
  assert.match(seen[0], /\/repos\/o\/r\/x\?a=1&per_page=100&page=1$/);
  assert.equal((await gh.list("/x", "items", (i) => i.n === 150)).length, 151);
});

test("the client refuses a malformed repository and reports HTTP errors", async () => {
  assert.throws(() => client({ repository: "nope" }), /owner\/name/);
  const gh = client({ repository: "o/r", fetchImpl: async () => new Response("rate limited", { status: 403 }) });
  await assert.rejects(gh.get("/x"), /HTTP 403 rate limited/);
});

test("the action end to end against a fake API: job and event filters, files, outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dora-"));
  const now = new Date("2026-11-30T12:00:00Z");
  const run_ = (id, sha, conclusion, day) => ({ id, head_sha: sha, conclusion, updated_at: `2026-11-${day}T10:00:00Z` });
  const runs = [run_(3, "s3", "success", 29), run_(2, "s2", "failure", 28), run_(1, "s1", "success", 25), run_(0, "s0", "success", 10)];
  const jobs = { 3: "success", 2: "failure", 1: "success", 0: "success" };
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/actions/workflows/deploy.yml/runs")) return json({ workflow_runs: runs });
    const m = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return json({ jobs: [{ name: "test", conclusion: "success" }, { name: "deploy", conclusion: jobs[m[1]], completed_at: `2026-11-${{ 3: 29, 2: 28, 1: 25, 0: 10 }[m[1]]}T10:05:00Z` }] });
    if (u.pathname.includes("/compare/s0...s1")) return json({ status: "ahead", commits: [{ sha: "c1", commit: { committer: { date: "2026-11-25T09:05:00Z" } } }] });
    if (u.pathname.includes("/compare/s1...s3")) return json({ status: "ahead", commits: [{ sha: "c3", commit: { committer: { date: "2026-11-29T07:05:00Z" } } }] });
    return json({ message: "Not Found" }, 404);
  };
  const env = {
    "INPUT_WORKFLOW": "deploy.yml",
    "INPUT_REPOSITORY": "o/r",
    "INPUT_JOB": "deploy",
    "INPUT_EVENT": "workflow_run",
    "INPUT_WINDOW-DAYS": "10",
    "INPUT_OUTPUT-DIR": dir,
    GITHUB_OUTPUT: join(dir, "out.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
  };
  const m = await run({ env, now, fetchImpl, log: () => {} });
  assert.equal(m.deploys, 2);
  assert.equal(m.failed, 1);
  assert.deepEqual(m.leadTimeHours, { median: 2, commits: 2 }); // 1 h and 3 h
  assert.deepEqual(m.timeToRestoreHours, { median: 24, count: 1 });
  assert.ok(urls[0].includes("event=workflow_run") && urls[0].includes("branch=main") && urls[0].includes("status=completed"));
  const saved = JSON.parse(await readFile(join(dir, "dora.json"), "utf8"));
  assert.equal(saved.repository, "o/r");
  assert.equal(saved.job, "deploy");
  assert.match(await readFile(join(dir, "dora-dark.svg"), "utf8"), /o\/r <tspan/);
  assert.match(await readFile(join(dir, "dora-light.svg"), "utf8"), /#ffffff/);
  const out = await readFile(join(dir, "out.txt"), "utf8");
  assert.match(out, /^deploys=2$/m);
  assert.match(out, /^change-failure-rate=0\.333$/m);
  assert.match(await readFile(join(dir, "summary.md"), "utf8"), /\| lead time \| 2\.0 h \| median of 2 commits \|/);
});

test("the action says what is wrong with its inputs", async () => {
  await assert.rejects(run({ env: { INPUT_REPOSITORY: "o/r" }, fetchImpl: async () => json({}) }), /workflow input is required/);
  await assert.rejects(run({ env: { INPUT_REPOSITORY: "o/r", INPUT_WORKFLOW: "d.yml", "INPUT_WINDOW-DAYS": "0" }, fetchImpl: async () => json({}) }), /window-days/);
});
