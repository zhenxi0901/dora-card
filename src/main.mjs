// The action: read a deploy workflow's history, measure, draw, write. No dependencies.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./github.mjs";
import { measure, outcomeOf } from "./dora.mjs";
import { card, figures } from "./card.mjs";

const DAY = 864e5;

/** A workflow command's text on one line, so that text from the API can't start a command of its own. */
const oneLine = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** Whether a job's display name is the one the `job` input names: exactly, or with a matrix or other suffix, as in "deploy (prod)". */
export const isJob = (name, job) => name === job || name.startsWith(`${job} (`);

export async function run({ env = process.env, now = new Date(), fetchImpl = fetch, log = console.log } = {}) {
  /** An action input: GitHub passes `window-days` as INPUT_WINDOW-DAYS. */
  const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;
  const warn = (message) => log(`::warning::${oneLine(message)}`);
  const repository = input("repository", env.GITHUB_REPOSITORY);
  const workflow = input("workflow");
  if (!workflow) throw new Error("the workflow input is required: the deploy workflow's file name, such as deploy.yml");
  const job = input("job");
  const event = input("event");
  const windowDays = Number(input("window-days", "30"));
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error(`window-days must be a whole number from 1 to 365, got "${input("window-days")}"`);
  const title = input("title", repository);
  const outDir = input("output-dir", "dora");
  const gh = client({ repository, token: input("token", env.GITHUB_TOKEN), fetchImpl, warn });
  // No branch given: the repository's default branch, which costs one request.
  const branch = input("branch") || (await gh.get("")).default_branch;
  const since = new Date(now.getTime() - windowDays * DAY);

  // The deploys a run made, one for each attempt, so that a failure fixed by a re-run still counts.
  // With a job named, by that job's own result (the rest of the workflow may test, release or clean
  // up), read from the jobs of every attempt; without, by the run's result, and a re-run's earlier
  // attempts are read for theirs.
  const jobs = { read: 0, found: false, names: new Set() };
  async function deploysOf(r) {
    const attempt = (n, outcome, ended) => ({ id: r.id, attempt: n, sha: r.head_sha, ended: new Date(ended), outcome });
    if (!job) {
      const earlier = await Promise.all(Array.from({ length: (r.run_attempt ?? 1) - 1 }, (_, i) => gh.get(`/actions/runs/${r.id}/attempts/${i + 1}`)));
      return [...earlier, r].map((a) => attempt(a.run_attempt ?? 1, outcomeOf(a.conclusion), a.updated_at));
    }
    if (r.conclusion === "skipped") return []; // a skipped run ran none of its jobs
    const all = await Array.fromAsync(gh.list(`/actions/runs/${r.id}/jobs?filter=all`, "jobs"));
    jobs.read++;
    for (const j of all) jobs.names.add(j.name);
    const mine = all.filter((j) => isJob(j.name, job));
    jobs.found ||= mine.length > 0;
    // An attempt failed if one of its matching jobs failed, and deployed if one succeeded. A skipped
    // or missing job deployed nothing.
    return [...Map.groupBy(mine, (j) => j.run_attempt ?? 1)].map(([n, legs]) => {
      const outcomes = legs.map((j) => outcomeOf(j.conclusion));
      const outcome = outcomes.includes("failed") ? "failed" : outcomes.includes("deploy") ? "deploy" : null;
      return attempt(n, outcome, Math.max(...legs.map((j) => Date.parse(j.completed_at ?? r.updated_at))));
    });
  }

  // The completed runs on the branch, newest first: every run that ended in the window, read four at
  // a time, then back to the last deploy before it, as lead time needs to know what was already live
  // when the window opened.
  const listing = gh.runs(workflow, { branch, status: "completed", ...(event ? { event } : {}) });
  const next = async () => (await listing.next()).value;
  const recent = [];
  let r = await next();
  while (r && new Date(r.updated_at) >= since) {
    recent.push(r);
    r = await next();
  }
  const noRuns = !r && !recent.length;
  const runs = (await Promise.all(recent.map(deploysOf))).flat();
  while (r) {
    const made = await deploysOf(r);
    runs.push(...made);
    if (made.some((d) => d.outcome === "deploy")) break;
    r = await next();
  }
  if (noRuns) {
    warn(`No completed runs of ${workflow} on the ${branch} branch${event ? ` started by ${event}` : ""}: check the workflow, branch and event inputs.`);
  } else if (job && jobs.read && !jobs.found) {
    const names = [...jobs.names].slice(0, 10).map((n) => `"${n}"`).join(", ");
    warn(`No job named "${job}" in ${jobs.read === 1 ? "the one run" : `any of the ${jobs.read} runs`} read, so no deploys were counted. Their jobs are named ${names}: the job input takes a job's display name.`);
  }

  // The commits a deploy added to the one before it. A comparison that fails (a deployed commit lost
  // to a force-push, say) leaves out that deploy's commits, with a warning, rather than the whole
  // card. A token that can't read, or has run out of requests, still stops the action.
  const added = async (base, head) => {
    try {
      const cmp = await gh.get(`/compare/${base}...${head}`);
      if (cmp.status === "behind" || cmp.status === "identical") return [];
      return cmp.commits.map((c) => ({ sha: c.sha, at: new Date(c.commit.committer.date) }));
    } catch (e) {
      if ([401, 403, 429].includes(e.status)) throw e;
      warn(`Could not compare ${base.slice(0, 7)}...${head.slice(0, 7)} (${e.status ? `HTTP ${e.status}` : e.message}), so the lead time leaves out the commits that deploy shipped.`);
      return [];
    }
  };
  const m = await measure({ runs, added, now, windowDays });

  await mkdir(outDir, { recursive: true });
  const meta = { repository, workflow, branch, job: job || null, event: event || null };
  await writeFile(join(outDir, "dora.json"), `${JSON.stringify({ ...meta, ...m }, null, 2)}\n`);
  await writeFile(join(outDir, "dora-dark.svg"), card(m, { title, theme: "dark" }));
  await writeFile(join(outDir, "dora-light.svg"), card(m, { title, theme: "light" }));

  const f = figures(m);
  const outputs = {
    deploys: m.deploys,
    "deploys-per-week": m.deploysPerWeek.toFixed(2),
    "lead-time-hours": m.leadTimeHours.median?.toFixed(2) ?? "",
    "change-failure-rate": m.changeFailureRate?.toFixed(3) ?? "",
    "time-to-restore-hours": m.timeToRestoreHours.median?.toFixed(2) ?? "",
  };
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = f.map((x) => `| ${x.label} | ${x.value} | ${x.note} |`).join("\n");
    await appendFile(env.GITHUB_STEP_SUMMARY, `### DORA metrics: ${title}\n\nLast ${windowDays} days of \`${workflow}\` on \`${branch}\`.\n\n| Metric | Value | |\n|---|---|---|\n${rows}\n`);
  }
  for (const x of f) log(`${x.label.padEnd(20)} ${x.value.padEnd(10)} ${x.note}`);
  return m;
}

// Run when executed (`node src/main.mjs`, which is what the action does), not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => {
    console.log(`::error::${oneLine(e.message)}`);
    process.exitCode = 1;
  });
}
