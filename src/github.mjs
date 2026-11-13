// A small GitHub REST client: no dependencies, so the action runs straight from its source. It only
// reads. It keeps at most four requests in flight, gives each one 30 seconds, and tries again a few
// times when GitHub is briefly down or asks it to slow down.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function client({
  repository,
  token,
  api = "https://api.github.com",
  fetchImpl = fetch,
  concurrency = 4,
  timeoutMs = 30_000,
  retries = 3,
  sleep = pause,
  warn = (message) => console.log(`::warning::${message}`),
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error(`repository must be owner/name, got "${repository}"`);
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dora-card",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  // At most `concurrency` requests at once. One that finishes hands its place to the next in line.
  let active = 0;
  const queue = [];
  async function inTurn(task) {
    if (active < concurrency) active++;
    else await new Promise((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  }

  /** One try: the parsed body, or what went wrong and how long to wait before the next try (null: don't). */
  async function once(url, n) {
    const backoff = 1000 * 2 ** (n - 1); // 1, 2, 4 seconds
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { body: await res.json() };
      // Worth another try: GitHub's own errors, a 429, and a 403 that says how long to wait (the
      // secondary rate limit). A 403 without retry-after is a permission; another try won't help.
      const after = Number(res.headers.get("retry-after")) * 1000 || 0;
      const again = res.status >= 500 || res.status === 429 || (res.status === 403 && after > 0);
      return { problem: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, status: res.status, wait: again ? after || backoff : null };
    } catch (e) {
      // No answer, or only part of one: a network error or the time limit.
      return { problem: e.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : e.message, wait: backoff };
    }
  }

  /** GET a path under the repository, parsed. A failure throws, with `status` set when GitHub answered. */
  function get(path) {
    return inTurn(async () => {
      for (let n = 1; ; n++) {
        const r = await once(`${api}/repos/${repository}${path}`, n);
        if ("body" in r) return r.body;
        // Out of tries, or asked to wait more than a minute: give up.
        if (r.wait === null || n > retries || r.wait > 60_000) throw Object.assign(new Error(`GET /repos/${repository}${path}: ${r.problem}`), { status: r.status });
        await sleep(r.wait);
      }
    });
  }

  /** The items of a paged list, a page of 100 at a time, until a short page. */
  async function* list(path, key) {
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 50; page++) {
      const items = (await get(`${path}${sep}per_page=100&page=${page}`))[key];
      yield* items;
      if (items.length < 100) return;
    }
  }

  /**
   * A workflow's runs that match `filters`, newest first. GitHub ends a filtered list at 1,000 runs
   * (page 11 comes back empty), so after ten full pages this starts again from the oldest run it has
   * seen, with created=<= that run's time, and skips the runs it has already returned. It stops,
   * with a warning, once it has read `most`.
   */
  async function* runs(workflow, filters, most = 5000) {
    const path = `/actions/workflows/${encodeURIComponent(workflow)}/runs`;
    const seen = new Set();
    let oldest = "";
    while (seen.size < most) {
      const query = new URLSearchParams(filters);
      if (oldest) query.set("created", `<=${oldest}`);
      const before = seen.size;
      for (let page = 1; page <= 10; page++) {
        const { workflow_runs: items } = await get(`${path}?${query}&per_page=100&page=${page}`);
        for (const r of items) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          oldest = r.created_at;
          yield r;
        }
        if (items.length < 100) return;
      }
      if (seen.size === before) break; // ten full pages of runs already seen: no way past them
    }
    warn(`Stopped reading ${workflow}'s runs after ${seen.size}, so older ones are left out and the numbers may be off.`);
  }

  return { get, list, runs };
}
