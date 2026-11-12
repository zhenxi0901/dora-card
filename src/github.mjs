// A small GitHub REST client: no dependencies, so the action runs straight from its source.

export function client({ repository, token, api = "https://api.github.com", fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error(`repository must be owner/name, got "${repository}"`);
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dora-card",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  async function get(path) {
    const res = await fetchImpl(`${api}/repos/${repository}${path}`, { headers });
    if (!res.ok) throw new Error(`GET /repos/${repository}${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  /** Every item of a paged list, newest first, until `enough(item)` says the rest are not needed. */
  async function list(path, key, enough = () => false) {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await get(`${path}${sep}per_page=100&page=${page}`);
      const items = key ? body[key] : body;
      for (const item of items) {
        out.push(item);
        if (enough(item)) return out;
      }
      if (items.length < 100) break;
    }
    return out;
  }
  return { get, list };
}
