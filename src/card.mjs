// The card: four numbers, a bar per day, light or dark. Plain SVG with system fonts, so it renders
// the same through GitHub's image proxy as anywhere else.

const THEMES = {
  dark: { bg: "#0d1117", border: "#30363d", ink: "#e6edf3", muted: "#8b949e", accent: "#c2f75c", bar: "#c2f75c", fail: "#f85149", track: "#21262d" },
  light: { bg: "#ffffff", border: "#d0d7de", ink: "#1f2328", muted: "#59636e", accent: "#3f6212", bar: "#4d7c0f", fail: "#cf222e", track: "#eaeef2" },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Hours as minutes, hours or days, whichever reads best. */
export function duration(h) {
  if (h === null || h === undefined) return "–";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The four headline numbers with their small print, in the card's order. */
export function figures(m) {
  const attempts = m.deploys + m.failed;
  return [
    { value: String(m.deploys), label: "deploys", note: `${m.deploysPerWeek.toFixed(1)} a week` },
    {
      value: duration(m.leadTimeHours.median),
      label: "lead time",
      note: m.leadTimeHours.commits ? `median of ${plural(m.leadTimeHours.commits, "commit")}` : "no commits shipped",
    },
    {
      value: m.changeFailureRate === null ? "–" : `${Math.round(m.changeFailureRate * 100)}%`,
      label: "change failure rate",
      note: attempts ? `${m.failed} of ${attempts}` : "no deploys",
    },
    {
      value: duration(m.timeToRestoreHours.median),
      label: "time to restore",
      note: m.timeToRestoreHours.count ? `median of ${plural(m.timeToRestoreHours.count, "incident")}` : m.failed ? "not restored yet" : "no failures",
    },
  ];
}

/**
 * @param {object} m what measure() returned
 * @param {{ title: string, theme?: "dark" | "light" }} o
 */
export function card(m, { title, theme = "dark" }) {
  const c = THEMES[theme];
  const W = 820;
  const H = 236;
  const f = figures(m);
  const cols = [24, 228, 432, 636];
  const days = m.perDay.length;
  const slot = (W - 48) / days;
  const most = Math.max(1, ...m.perDay.map((d) => d.deploys + d.failed));
  const bars = m.perDay
    .map((d, i) => {
      const x = 24 + i * slot;
      const w = Math.max(2, slot - 3);
      const h = ((d.deploys + d.failed) / most) * 40;
      const failH = (d.failed / most) * 40;
      return [
        `<rect x="${x.toFixed(1)}" y="150" width="${w.toFixed(1)}" height="40" rx="2" fill="${c.track}"/>`,
        h ? `<rect x="${x.toFixed(1)}" y="${(190 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${c.bar}"/>` : "",
        failH ? `<rect x="${x.toFixed(1)}" y="${(190 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${failH.toFixed(1)}" rx="2" fill="${c.fail}"/>` : "",
      ].join("");
    })
    .join("");
  const asOf = `${m.generated.slice(0, 10)} ${m.generated.slice(11, 16)} UTC`;
  const desc = `${f.map((x) => `${x.label}: ${x.value} (${x.note})`).join("; ")}; over the last ${m.windowDays} days, as of ${asOf}.`;
  const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
  const mono = `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}: DORA metrics</title>
<desc id="d">${esc(desc)}</desc>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${c.bg}" stroke="${c.border}"/>
<circle cx="31" cy="32" r="5" fill="${c.accent}"/>
<text x="44" y="37" ${font} font-size="16" font-weight="600" fill="${c.ink}">${esc(title)} <tspan fill="${c.muted}" font-weight="400">· DORA metrics</tspan></text>
<text x="${W - 24}" y="37" ${mono} font-size="12" fill="${c.muted}" text-anchor="end">last ${m.windowDays} days</text>
${f
  .map(
    (x, i) => `<text x="${cols[i]}" y="90" ${font} font-size="30" font-weight="600" fill="${i === 0 ? c.accent : c.ink}">${esc(x.value)}</text>
<text x="${cols[i]}" y="112" ${font} font-size="13" fill="${c.ink}">${esc(x.label)}</text>
<text x="${cols[i]}" y="130" ${font} font-size="12" fill="${c.muted}">${esc(x.note)}</text>`,
  )
  .join("\n")}
${bars}
<text x="24" y="216" ${mono} font-size="11" fill="${c.muted}">as of ${esc(asOf)} · a bar per day, failures in red</text>
<text x="${W - 24}" y="216" ${mono} font-size="11" fill="${c.muted}" text-anchor="end">dora-card</text>
</svg>
`;
}
