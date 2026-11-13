// The four DORA metrics from a deploy workflow's history. Pure: the caller passes the runs and a
// way to ask which commits a deploy added, so this is tested without the network.
//
//   deployment frequency   successful deploys in the window, per week
//   lead time for changes  for each commit shipped by a deploy in the window, whenever it was
//                          committed: when that deploy finished, minus when it was committed; the median
//   change failure rate    failed deploys / (successful + failed) deploys in the window
//   time to restore        for each incident (consecutive failed deploys, one of them in the window):
//                          from its first failure until the next successful deploy finished; the median

const DAY = 864e5;

/**
 * A deploy attempt: a run of the deploy workflow, or one attempt of it when it was re-run, reduced
 * to what the metrics need. `outcome` is "deploy" for a successful deploy, "failed" for one that
 * failed, and null for anything that did not deploy (cancelled, skipped, superseded).
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
 * @param {Run[]} o.runs every deploy attempt on the branch, any order, reaching back past the
 *   window far enough to include the last successful deploy before it (for lead time)
 * @param {(base: string, head: string) => Promise<Commit[]>} o.added the commits in head that base
 *   lacks, oldest first ([] when head is behind or the same, or when they can't be known). All the
 *   window's comparisons are asked for at once: the caller decides how many run at a time.
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

  // Lead time: each deploy in the window ships what the deploy before it lacked, however long ago
  // it was committed. A commit counts once, for the deploy that first shipped it.
  const shipping = [];
  deploys.forEach((d, i) => {
    const before = deploys[i - 1];
    if (before && before.sha !== d.sha && inWindow(d)) shipping.push({ base: before.sha, d });
  });
  const commits = await Promise.all(shipping.map(({ base, d }) => added(base, d.sha)));
  const lead = [];
  const shipped = new Set();
  shipping.forEach(({ d }, i) => {
    for (const c of commits[i]) {
      if (shipped.has(c.sha)) continue;
      shipped.add(c.sha);
      lead.push((d.ended - c.at) / 36e5);
    }
  });

  // Time to restore: consecutive failed deploys are one incident, from its first failure until the
  // next successful deploy. It counts when any of its failures is in the window.
  const restore = [];
  let incident = null;
  for (const r of counted) {
    if (r.outcome === "failed") {
      incident ??= { from: r.ended, counts: false };
      incident.counts ||= inWindow(r);
    } else if (incident) {
      if (incident.counts) restore.push((r.ended - incident.from) / 36e5);
      incident = null;
    }
  }

  // Deploys and failures per UTC day, oldest first: from the day the window opens (partway through
  // it) to today, so every deploy counted has a bar. That is windowDays + 1 bars.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const perDay = Array.from({ length: windowDays + 1 }, (_, k) => {
    const start = today - (windowDays - k) * DAY;
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
