// The four DORA metrics from a deploy workflow's history. Pure: the caller passes the runs and a
// way to ask which commits a deploy added, so this is tested without the network.
//
//   deployment frequency   successful deploys in the window, per week
//   lead time for changes  for each commit shipped in the window: when the deploy that first
//                          shipped it finished, minus when it was committed; the median
//   change failure rate    failed deploys / (successful + failed) deploys in the window
//   time to restore        for each failed deploy: until the next successful deploy finished; the median

const DAY = 864e5;

/**
 * A run of the deploy workflow, reduced to what the metrics need. `outcome` is "deploy" for a
 * successful deploy, "failed" for one that failed, and null for anything that did not deploy
 * (cancelled, skipped, superseded).
 * @typedef {{ id: number, sha: string, ended: Date, outcome: "deploy" | "failed" | null }} Run
 * @typedef {{ sha: string, at: Date }} Commit
 */

/** What a run's conclusion means for the metrics. A timeout is a failure; a cancelled run never deployed. */
export function outcomeOf(conclusion) {
  if (conclusion === "success") return "deploy";
  if (conclusion === "failure" || conclusion === "timed_out") return "failed";
  return null;
}

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {object} o
 * @param {Run[]} o.runs every deploy-workflow run on the branch, any order, reaching back past the
 *   window far enough to include the last successful deploy before it (for lead time)
 * @param {(base: string, head: string) => Promise<Commit[]>} o.added the commits in head that base
 *   lacks, oldest first ([] when head is behind or the same)
 * @param {Date} o.now
 * @param {number} o.windowDays
 */
export async function measure({ runs, added, now, windowDays }) {
  const since = new Date(now.getTime() - windowDays * DAY);
  const counted = runs.filter((r) => r.outcome).sort((a, b) => a.ended - b.ended);
  const deploys = counted.filter((r) => r.outcome === "deploy");
  const inWindow = (r) => r.ended >= since && r.ended <= now;
  const recentDeploys = deploys.filter(inWindow);
  const recentFailed = counted.filter((r) => r.outcome === "failed" && inWindow(r));

  // Lead time: walk the deploys in order; each ships what the last successful deploy lacked.
  const lead = [];
  const shipped = new Set();
  let deployedHead = null;
  for (const d of deploys) {
    if (d.ended > now) break;
    if (deployedHead && deployedHead !== d.sha && inWindow(d)) {
      for (const c of await added(deployedHead, d.sha)) {
        if (shipped.has(c.sha)) continue;
        shipped.add(c.sha);
        if (c.at >= since) lead.push((d.ended - c.at) / 36e5);
      }
    }
    deployedHead = d.sha;
  }

  // Time to restore: from a failed deploy to the next successful one.
  const restore = recentFailed
    .map((f) => deploys.find((d) => d.ended > f.ended))
    .map((next, i) => (next ? (next.ended - recentFailed[i].ended) / 36e5 : null))
    .filter((h) => h !== null);

  // Deploys and failures per UTC day, oldest first, ending today.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const perDay = Array.from({ length: windowDays }, (_, k) => {
    const start = today - (windowDays - 1 - k) * DAY;
    const on = (r) => r.ended.getTime() >= start && r.ended.getTime() < start + DAY;
    return { day: new Date(start).toISOString().slice(0, 10), deploys: recentDeploys.filter(on).length, failed: recentFailed.filter(on).length };
  });

  const attempts = recentDeploys.length + recentFailed.length;
  return {
    generated: now.toISOString(),
    windowDays,
    deploys: recentDeploys.length,
    failed: recentFailed.length,
    deploysPerWeek: (recentDeploys.length / windowDays) * 7,
    leadTimeHours: { median: median(lead), commits: lead.length },
    changeFailureRate: attempts ? recentFailed.length / attempts : null,
    timeToRestoreHours: { median: median(restore), count: restore.length },
    perDay,
  };
}
