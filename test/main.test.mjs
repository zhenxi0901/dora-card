import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client } from "../src/github.mjs";
import { isJob, run } from "../src/main.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body, status, headers = {}) => new Response(body, { status, headers });

// The client.

test("the client pages until a short page, and its caller can stop early", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return json({ items: Array.from({ length: page < 3 ? 100 : 7 }, (_, i) => ({ n: (page - 1) * 100 + i })) });
  };
  const gh = client({ repository: "o/r", token: "t", fetchImpl });
  assert.equal((await Array.fromAsync(gh.list("/x?a=1", "items"))).length, 207);
  assert.equal(seen.length, 3);
  assert.match(seen[0], /\/repos\/o\/r\/x\?a=1&per_page=100&page=1$/);
  seen.length = 0;
  for await (const item of gh.list("/x", "items")) if (item.n === 150) break;
  assert.equal(seen.length, 2);
});

test("the client refuses a malformed repository and reports HTTP errors", async () => {
  assert.throws(() => client({ repository: "nope" }), /owner\/name/);
  const gh = client({ repository: "o/r", fetchImpl: async () => text("Resource not accessible", 403) });
  await assert.rejects(gh.get("/x"), (e) => e.status === 403 && /HTTP 403 Resource not accessible/.test(e.message));
});

test("the client tries again after a 5xx, a 429 and a secondary rate limit, waiting as long as GitHub asks", async () => {
  const answers = [text("down", 502), text("slow down", 429, { "retry-after": "2" }), text("secondary rate limit", 403, { "retry-after": "1" }), json({ ok: true })];
  const waits = [];
  const gh = client({ repository: "o/r", fetchImpl: async () => answers.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await gh.get("/x"), { ok: true });
  assert.deepEqual(waits, [1000, 2000, 1000]); // a backoff, then retry-after twice
});

test("the client gives up after three more tries, and at once when another try can't help", async () => {
  let calls = 0;
  const waits = [];
  const answering = (answer) => client({ repository: "o/r", fetchImpl: async () => (calls++, answer()), sleep: async (ms) => waits.push(ms) });
  await assert.rejects(answering(() => text("unavailable", 503)).get("/x"), (e) => e.status === 503 && /HTTP 503 unavailable/.test(e.message));
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  // Not found, not allowed, and asked to wait an hour.
  for (const answer of [() => text("Not Found", 404), () => text("Resource not accessible", 403), () => text("wait", 429, { "retry-after": "3600" })]) {
    calls = 0;
    await assert.rejects(answering(answer).get("/x"));
    assert.equal(calls, 1);
  }
});

test("the client gives each request a time limit", async () => {
  let calls = 0;
  const hang = (url, { signal }) => (calls++, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  const gh = client({ repository: "o/r", fetchImpl: hang, timeoutMs: 20, retries: 1, sleep: async () => {} });
  await assert.rejects(gh.get("/x"), /no answer within 0\.02 s/);
  assert.equal(calls, 2);
});

test("the client keeps at most four requests in flight", async () => {
  let inFlight = 0;
  let most = 0;
  const fetchImpl = async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return json({});
  };
  const gh = client({ repository: "o/r", fetchImpl });
  await Promise.all(Array.from({ length: 12 }, (_, i) => gh.get(`/x/${i}`)));
  assert.equal(most, 4);
});

test("the client reads past the 1,000 runs GitHub stops a filtered list at, by creation time", async () => {
  // 2,345 runs, newest first, two to a second, so each restart begins on a run already returned.
  const all = Array.from({ length: 2345 }, (_, i) => ({ id: 1e6 - i, created_at: new Date(Date.UTC(2026, 10, 30) - Math.floor(i / 2) * 1000).toISOString().replace(".000Z", "Z") }));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const page = Number(q.get("page"));
    if (page > 10) return json({ total_count: 0, workflow_runs: [] }); // what GitHub does past 1,000
    const upTo = q.get("created")?.replace("<=", "");
    const match = upTo ? all.filter((r) => r.created_at <= upTo) : all;
    return json({ total_count: match.length, workflow_runs: match.slice((page - 1) * 100, page * 100) });
  };
  const warnings = [];
  const gh = client({ repository: "o/r", fetchImpl, warn: (w) => warnings.push(w) });
  const got = await Array.fromAsync(gh.runs("deploy.yml", { branch: "main", status: "completed" }));
  assert.deepEqual(got.map((r) => r.id), all.map((r) => r.id));
  assert.equal(urls.length, 24); // ten pages, ten more from the 1,000th run's time, then four
  assert.match(urls[10], /runs\?branch=main&status=completed&created=%3C%3D2026-11-29T23%3A51%3A41Z&per_page=100&page=1$/);
  assert.deepEqual(warnings, []);
  // It stops at `most`, and says so.
  assert.equal((await Array.fromAsync(gh.runs("deploy.yml", { branch: "main" }, 1000))).length, 1000);
  assert.match(warnings[0], /^Stopped reading deploy\.yml's runs after 1000/);
});

// The action, against a fake GitHub.

const day = (d, h = 10) => `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const now = new Date(day(30, 12)); // with a 10-day window, it opens on the 20th at noon

/** A fake GitHub for o/r: its default branch, deploy.yml's runs, their jobs and earlier attempts, and comparisons. */
function fakeGitHub({ defaultBranch = "main", runs = [], jobs = {}, attempts = {}, compare = {} }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/o\/r/, "");
    let m;
    if (path === "") return json({ default_branch: defaultBranch });
    if (path === "/actions/workflows/deploy.yml/runs") {
      const page = u.searchParams.get("page") === "1" ? runs : [];
      return json({ workflow_runs: page.filter((r) => (r.head_branch ?? "main") === u.searchParams.get("branch")) });
    }
    if ((m = path.match(/^\/actions\/runs\/(\d+)\/jobs$/))) return json({ jobs: jobs[m[1]] ?? [] });
    if ((m = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/))) return json(attempts[`${m[1]}/${m[2]}`]);
    if ((m = path.match(/^\/compare\/(.+)$/)) && compare[m[1]]) return typeof compare[m[1]] === "function" ? compare[m[1]]() : json(compare[m[1]]);
    return json({ message: "Not Found" }, 404);
  };
  return { fetchImpl, urls };
}
const ran = (id, sha, conclusion, ended, more = {}) => ({ id, head_sha: sha, conclusion, created_at: ended, updated_at: ended, ...more });
const deployJob = (conclusion, completed_at, more = {}) => ({ name: "deploy", conclusion, completed_at, run_attempt: 1, ...more });
const ahead = (...commits) => ({ status: "ahead", commits: commits.map(([sha, date]) => ({ sha, commit: { committer: { date } } })) });

async function act(fake, inputs = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dora-"));
  const lines = [];
  const env = { INPUT_REPOSITORY: "o/r", INPUT_WORKFLOW: "deploy.yml", "INPUT_WINDOW-DAYS": "10", "INPUT_OUTPUT-DIR": dir, ...inputs };
  const m = await run({ env, now, fetchImpl: fake.fetchImpl, log: (l) => lines.push(l) });
  return { m, dir, warnings: lines.filter((l) => l.startsWith("::warning::")) };
}

test("the action end to end against a fake API: job and event filters, files, outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dora-"));
  // Each run's deploy job ends five minutes after 10:00 on its day.
  const jobsOf = (conclusion, d) => [{ name: "test", conclusion: "success" }, deployJob(conclusion, `2026-11-${d}T10:05:00Z`)];
  const fake = fakeGitHub({
    runs: [ran(3, "s3", "success", day(29)), ran(2, "s2", "failure", day(28)), ran(1, "s1", "success", day(25)), ran(0, "s0", "success", day(10))],
    jobs: { 3: jobsOf("success", 29), 2: jobsOf("failure", 28), 1: jobsOf("success", 25), 0: jobsOf("success", 10) },
    compare: { "s0...s1": ahead(["c1", "2026-11-25T09:05:00Z"]), "s1...s3": ahead(["c3", "2026-11-29T07:05:00Z"]) },
  });
  const env = {
    INPUT_WORKFLOW: "deploy.yml",
    INPUT_REPOSITORY: "o/r",
    INPUT_JOB: "deploy",
    INPUT_EVENT: "workflow_run",
    "INPUT_WINDOW-DAYS": "10",
    "INPUT_OUTPUT-DIR": dir,
    GITHUB_OUTPUT: join(dir, "out.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
  };
  const m = await run({ env, now, fetchImpl: fake.fetchImpl, log: () => {} });
  assert.equal(m.deploys, 2);
  assert.equal(m.failed, 1);
  assert.deepEqual(m.leadTimeHours, { median: 2, commits: 2 }); // 1 h and 3 h
  assert.deepEqual(m.timeToRestoreHours, { median: 24, count: 1 });
  assert.match(fake.urls[0], /\/repos\/o\/r$/); // no branch given: the repository's default
  assert.ok(fake.urls[1].includes("event=workflow_run") && fake.urls[1].includes("branch=main") && fake.urls[1].includes("status=completed"));
  assert.ok(fake.urls.some((u) => u.endsWith("/actions/runs/3/jobs?filter=all&per_page=100&page=1")));
  const saved = JSON.parse(await readFile(join(dir, "dora.json"), "utf8"));
  assert.equal(saved.repository, "o/r");
  assert.equal(saved.branch, "main");
  assert.equal(saved.job, "deploy");
  assert.match(await readFile(join(dir, "dora-dark.svg"), "utf8"), /o\/r <tspan/);
  assert.match(await readFile(join(dir, "dora-light.svg"), "utf8"), /#ffffff/);
  const out = await readFile(join(dir, "out.txt"), "utf8");
  assert.match(out, /^deploys=2$/m);
  assert.match(out, /^change-failure-rate=0\.333$/m);
  assert.match(await readFile(join(dir, "summary.md"), "utf8"), /\| lead time \| 2\.0 h \| median of 2 commits \|/);
});

test("with no branch given, the repository's default branch; a job's matrix legs count as the job", async () => {
  const fake = fakeGitHub({
    defaultBranch: "master",
    runs: [ran(2, "s2", "success", day(29), { head_branch: "master" }), ran(1, "s1", "success", day(5), { head_branch: "master" })],
    jobs: {
      2: [deployJob("success", day(29, 10), { name: "deploy (eu)" }), deployJob("success", day(29, 11), { name: "deploy (us)" }), deployJob("failure", day(29, 11), { name: "deployment-notes" })],
      1: [deployJob("success", day(5), { name: "deploy (eu)" })],
    },
    compare: { "s1...s2": ahead(["c2", day(29, 8)]) },
  });
  const { m, warnings } = await act(fake, { INPUT_JOB: "deploy" });
  assert.ok(fake.urls[1].includes("branch=master"));
  assert.equal(m.deploys, 1);
  assert.equal(m.failed, 0); // deployment-notes is another job
  assert.deepEqual(m.leadTimeHours, { median: 3, commits: 1 }); // to the end of the last leg, at 11:00
  assert.deepEqual(warnings, []);
  assert.ok(isJob("deploy", "deploy") && isJob("deploy (prod)", "deploy"));
  assert.ok(!isJob("deployment", "deploy") && !isJob("Deploy", "deploy") && !isJob("deploy (prod)", "deploy (staging)"));
  // A branch given: no request for the default.
  const given = fakeGitHub({ runs: [] });
  await act(given, { INPUT_BRANCH: "main" });
  assert.ok(!given.urls.some((u) => new URL(u).pathname === "/repos/o/r"));
});

test("with a job named, its own result decides, also for the last deploy before the window", async () => {
  const fake = fakeGitHub({
    runs: [
      ran(4, "s4", "cancelled", day(29)), // deployed; a later job was cancelled
      ran(3, "s3", "success", day(27)), // the deploy job was skipped
      ran(2, "s2", "skipped", day(26)), // nothing ran, so its jobs are not read
      ran(1, "s1", "success", day(15)), // before the window, but the deploy job was skipped: not the baseline
      ran(0, "s0", "failure", day(14)), // deployed; a later job failed. The baseline.
    ],
    jobs: {
      4: [deployJob("success", day(29)), { name: "release", conclusion: "cancelled" }],
      3: [deployJob("skipped", null)],
      1: [deployJob("skipped", null)],
      0: [deployJob("success", day(14)), { name: "release", conclusion: "failure" }],
    },
    compare: { "s0...s4": ahead(["c4", day(28)]) },
  });
  const { m, warnings } = await act(fake, { INPUT_JOB: "deploy" });
  assert.equal(m.deploys, 1);
  assert.equal(m.failed, 0);
  assert.deepEqual(m.leadTimeHours, { median: 24, commits: 1 });
  assert.ok(!fake.urls.some((u) => u.includes("/runs/2/jobs")));
  assert.deepEqual(warnings, []);
});

test("re-runs: every attempt counts, so a failure fixed by a re-run is a failed deploy and a restore", async () => {
  // Run 2's deploy failed at 10:00 on the 28th and passed on "Re-run failed jobs" at 13:00.
  const runs = [ran(2, "s2", "success", day(28, 13), { run_attempt: 2 }), ran(1, "s1", "success", day(5))];
  const compare = { "s1...s2": ahead(["c2", day(28, 9)]) };
  const withJob = fakeGitHub({
    runs,
    compare,
    jobs: {
      2: [{ name: "test", conclusion: "success", run_attempt: 1 }, deployJob("failure", day(28, 10)), deployJob("success", day(28, 13), { run_attempt: 2 })],
      1: [deployJob("success", day(5))],
    },
  });
  const withoutJob = fakeGitHub({ runs, compare, attempts: { "2/1": ran(2, "s2", "failure", day(28, 10), { run_attempt: 1 }) } });
  for (const [fake, inputs] of [[withJob, { INPUT_JOB: "deploy" }], [withoutJob, {}]]) {
    const { m } = await act(fake, inputs);
    assert.equal(m.deploys, 1);
    assert.equal(m.failed, 1);
    assert.equal(m.changeFailureRate, 0.5);
    assert.deepEqual(m.timeToRestoreHours, { median: 3, count: 1 });
    assert.deepEqual(m.leadTimeHours, { median: 4, commits: 1 }); // shipped by the attempt that passed
  }
  assert.ok(withoutJob.urls.some((u) => u.endsWith("/actions/runs/2/attempts/1")));
});

test("a comparison that fails leaves that deploy's commits out, with a warning; an unreadable one stops the action", async () => {
  const runs = [ran(3, "s3", "success", day(29)), ran(2, "gone", "success", day(28)), ran(1, "s1", "success", day(5))];
  const fake = fakeGitHub({ runs, compare: { "gone...s3": ahead(["c3", day(29, 8)]) } });
  const { m, dir, warnings } = await act(fake);
  assert.equal(m.deploys, 2);
  assert.deepEqual(m.leadTimeHours, { median: 2, commits: 1 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::Could not compare s1\.\.\.gone \(HTTP 404\), so the lead time leaves out/);
  assert.match(await readFile(join(dir, "dora-dark.svg"), "utf8"), /<svg /);
  const denied = fakeGitHub({ runs, compare: { "s1...gone": () => text("Resource not accessible by integration", 403), "gone...s3": ahead() } });
  await assert.rejects(act(denied), /HTTP 403 Resource not accessible/);
});

test("the action warns when no runs match, and when the job is in none of them", async () => {
  let { m, warnings } = await act(fakeGitHub({ runs: [ran(1, "s1", "success", day(29), { head_branch: "master" })] }), { INPUT_EVENT: "push" });
  assert.equal(m.deploys, 0);
  assert.deepEqual(warnings, ["::warning::No completed runs of deploy.yml on the main branch started by push: check the workflow, branch and event inputs."]);
  // Job names come from the repository's workflow, so they are kept to one line.
  const named = { 1: [{ name: "Deploy to production", conclusion: "success" }, { name: "two\nlines", conclusion: "success" }] };
  ({ m, warnings } = await act(fakeGitHub({ runs: [ran(1, "s1", "success", day(29))], jobs: named }), { INPUT_JOB: "deploy" }));
  assert.equal(m.deploys, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::No job named "deploy" in the one run read, so no deploys were counted\. Their jobs are named "Deploy to production", "two%0Alines"/);
});

test("the action says what is wrong with its inputs", async () => {
  await assert.rejects(run({ env: { INPUT_REPOSITORY: "o/r" }, fetchImpl: async () => json({}) }), /workflow input is required/);
  await assert.rejects(run({ env: { INPUT_REPOSITORY: "o/r", INPUT_WORKFLOW: "d.yml", "INPUT_WINDOW-DAYS": "0" }, fetchImpl: async () => json({}) }), /window-days/);
});
