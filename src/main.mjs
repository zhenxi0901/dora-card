// The action: read a deploy workflow's history, measure, draw, write. No dependencies.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "./github.mjs";
import { measure, outcomeOf } from "./dora.mjs";
import { card, figures } from "./card.mjs";

const DAY = 864e5;

export async function run({ env = process.env, now = new Date(), fetchImpl = fetch, log = console.log } = {}) {
  /** An action input: GitHub passes `window-days` as INPUT_WINDOW-DAYS. */
  const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;
  const repository = input("repository", env.GITHUB_REPOSITORY);
  const workflow = input("workflow");
  if (!workflow) throw new Error("the workflow input is required: the deploy workflow's file name, such as deploy.yml");
  const branch = input("branch", "main");
  const job = input("job");
  const event = input("event");
  const windowDays = Number(input("window-days", "30"));
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error(`window-days must be a whole number from 1 to 365, got "${input("window-days")}"`);
  const title = input("title", repository);
  const outDir = input("output-dir", "dora");
  const gh = client({ repository, token: input("token", env.GITHUB_TOKEN), fetchImpl });
  const since = new Date(now.getTime() - windowDays * DAY);

  // Completed runs on the branch, newest first, back to the last success before the window: lead
  // time needs to know what was already deployed when the window opened.
  const query = new URLSearchParams({ branch, status: "completed", ...(event ? { event } : {}) });
  const listed = await gh.list(`/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`, "workflow_runs", (r) => r.conclusion === "success" && new Date(r.updated_at) < since);

  const runs = [];
  for (const r of listed) {
    let conclusion = r.conclusion;
    let ended = new Date(r.updated_at);
    // With a job named, a run deploys only if that job did: the rest of the workflow may test,
    // release or clean up.
    if (job && outcomeOf(conclusion) !== null) {
      const { jobs } = await gh.get(`/actions/runs/${r.id}/jobs?per_page=100`);
      const j = jobs.find((x) => x.name === job);
      if (!j) continue;
      conclusion = j.conclusion;
      if (j.completed_at) ended = new Date(j.completed_at);
    }
    runs.push({ id: r.id, sha: r.head_sha, ended, outcome: outcomeOf(conclusion) });
  }

  const added = async (base, head) => {
    const cmp = await gh.get(`/compare/${base}...${head}`);
    if (cmp.status === "behind" || cmp.status === "identical") return [];
    return cmp.commits.map((c) => ({ sha: c.sha, at: new Date(c.commit.committer.date) }));
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
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
