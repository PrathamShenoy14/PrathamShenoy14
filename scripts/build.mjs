#!/usr/bin/env node
// Builds the profile panel: a stack of seamless SVG slices plus README.md.
//
//   node scripts/build.mjs            fetch fresh data from GitHub, then build
//   node scripts/build.mjs --offline  build from the cached data/*.json only
//
// A token is read from GITHUB_TOKEN / GH_TOKEN, or from `gh auth token`.
// Requires Node.js 20+. No npm dependencies.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(join(ROOT, "profile.config.json"), "utf8"));
const P = cfg.palette;
const OFFLINE = process.argv.includes("--offline");

// ---------------------------------------------------------------- data

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try { return execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return ""; }
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "profile-panel-build",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchContributions() {
  const q = encodeURIComponent(`author:${cfg.login} is:pr is:merged -user:${cfg.login}`);
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const r = await gh(`/search/issues?q=${q}&per_page=100&page=${page}`);
    items.push(...r.items);
    if (items.length >= r.total_count || r.items.length === 0) break;
  }
  const exclude = new Set((cfg.openSource.exclude || []).map((s) => s.toLowerCase()));
  const byRepo = new Map();
  for (const it of items) {
    const full = it.repository_url.replace("https://api.github.com/repos/", "");
    if (exclude.has(full.toLowerCase())) continue;
    if (!byRepo.has(full)) byRepo.set(full, []);
    byRepo.get(full).push({ number: it.number, title: it.title, mergedAt: it.pull_request?.merged_at || it.closed_at });
  }
  const repos = [];
  for (const [full, prs] of byRepo) {
    const meta = await gh(`/repos/${full}`);
    prs.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    repos.push({ repository: meta.full_name, stars: meta.stargazers_count, language: meta.language, description: meta.description, prs });
  }
  repos.sort((a, b) => b.prs.length - a.prs.length || b.stars - a.stars || a.repository.localeCompare(b.repository));
  return { repos };
}

async function fetchActivity() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const r = await gh("/graphql", { method: "POST", body: JSON.stringify({ query, variables: { login: cfg.login } }) });
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  const cal = r.data.user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) => w.contributionDays.map((d) => [d.date, d.contributionCount])),
    refreshedAt: new Date().toISOString(),
  };
}

function cached(name, fresh) {
  const file = join(ROOT, "data", `${name}.json`);
  if (fresh) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(fresh, null, 2) + "\n");
    return fresh;
  }
  if (!existsSync(file)) throw new Error(`no cached ${file}; run without --offline first`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const TOKEN = OFFLINE ? "" : token();
let contributions, activity;
if (OFFLINE) {
  contributions = cached("contributions");
  activity = cached("activity");
} else {
  contributions = cached("contributions", await fetchContributions().catch((e) => { console.warn("contributions:", e.message); return null; }));
  activity = cached("activity", await fetchActivity().catch((e) => { console.warn("activity:", e.message); return null; }));
}

// ---------------------------------------------------------------- fonts & text

const FONT_DIR = join(ROOT, "assets", "fonts");
const METRICS = JSON.parse(readFileSync(join(FONT_DIR, "metrics.json"), "utf8"));
const FONTS = {
  sg4: "space-grotesk-400",
  sg5: "space-grotesk-500",
  sg7: "space-grotesk-700",
  mono: "jetbrains-mono-500",
};
const FONT_DATA = Object.fromEntries(
  Object.entries(FONTS).map(([k, f]) => [k, readFileSync(join(FONT_DIR, `${f}.subset.woff2`)).toString("base64")]),
);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (n) => Math.round(n * 100) / 100;

function measure(text, font, size, spacing = 0) {
  const m = METRICS[FONTS[font]];
  let w = 0;
  for (const ch of text) w += m[ch] ?? 0.6;
  return w * size + spacing * Math.max(0, [...text].length - 1);
}

function fit(text, font, size, max, spacing = 0) {
  if (measure(text, font, size, spacing) <= max) return text;
  let t = text;
  while (t.length > 1 && measure(t + "…", font, size, spacing) > max) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

function wrap(text, font, size, max, lines = 2) {
  const words = text.split(" ");
  const out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next, font, size) <= max || !cur) cur = next;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const head = out.slice(0, lines - 1);
    return [...head, fit(out.slice(lines - 1).join(" "), font, size, max)];
  }
  return out.map((l) => fit(l, font, size, max));
}

// A tiny SVG writer that remembers which fonts a slice uses.
class Canvas {
  constructor() { this.parts = []; this.fonts = new Set(); }
  add(s) { this.parts.push(s); return this; }
  text(x, y, str, { font = "sg4", size = 16, fill = P.text, anchor = "start", spacing = 0, opacity } = {}) {
    this.fonts.add(font);
    const ls = spacing ? ` letter-spacing="${spacing}"` : "";
    const op = opacity != null ? ` fill-opacity="${opacity}"` : "";
    return this.add(`<text x="${r2(x)}" y="${r2(y)}" font-family="${font}" font-size="${size}" fill="${fill}"${op} text-anchor="${anchor}"${ls}>${esc(str)}</text>`);
  }
  // Text whose pieces have different colours, laid out left to right.
  spans(x, y, pieces, { font, size, anchor = "start" }) {
    const total = pieces.reduce((w, p) => w + measure(p.text, font, size), 0);
    let cx = anchor === "end" ? x - total : anchor === "middle" ? x - total / 2 : x;
    for (const p of pieces) { this.text(cx, y, p.text, { font, size, fill: p.fill }); cx += measure(p.text, font, size); }
    return total;
  }
}

// ---------------------------------------------------------------- glyphs

const ICONS = Object.fromEntries(
  cfg.tools.map((t) => {
    const svg = readFileSync(join(ROOT, "assets", "icons", `${t.slug}.svg`), "utf8");
    return [t.slug, [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])];
  }),
);

const arrowUR = (x, y, s, color, w = 1.6) =>
  `<path d="M${r2(x)} ${r2(y + s)}L${r2(x + s)} ${r2(y)}M${r2(x + s * 0.3)} ${r2(y)}H${r2(x + s)}V${r2(y + s * 0.7)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

const mergeIcon = (x, y, s, color) => {
  const k = s / 16;
  const p = (a, b) => `${r2(x + a * k)} ${r2(y + b * k)}`;
  return `<g fill="none" stroke="${color}" stroke-width="${r2(1.5)}" stroke-linecap="round">` +
    `<circle cx="${r2(x + 4 * k)}" cy="${r2(y + 3 * k)}" r="${r2(2 * k)}"/>` +
    `<circle cx="${r2(x + 4 * k)}" cy="${r2(y + 13 * k)}" r="${r2(2 * k)}"/>` +
    `<circle cx="${r2(x + 12 * k)}" cy="${r2(y + 9 * k)}" r="${r2(2 * k)}"/>` +
    `<path d="M${p(4, 5)}V${r2(y + 11 * k)}M${p(4, 5)}C${p(4, 8.5)} ${p(6, 9)} ${p(10, 9)}"/></g>`;
};

const star = (cx, cy, r, color) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(`${r2(cx + rr * Math.cos(a))},${r2(cy + rr * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${color}"/>`;
};

const LANG = { Go: "#00ADD8", JavaScript: "#F1E05A", TypeScript: "#3178C6", Rust: "#DEA584", Python: "#3572A5", Java: "#B07219", "C#": "#178600", "C++": "#F34B7D", PHP: "#4F5D95", Ruby: "#701516", Kotlin: "#A97BFF", Swift: "#F05138" };
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const fmtDate = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

// ---------------------------------------------------------------- layout

// Both layouts share the same horizontal cuts (fractions of the width), so one
// <img width="x%"> works for both; only heights and drawing differ.
const EDGE = 64 / 1200; // side padding as a fraction of the width
const ROW_INFO = 0.28, ROW_CELL = 0.112, ROW_SLOTS = 6;

const repos = contributions.repos;
const totalPRs = repos.reduce((n, r) => n + r.prs.length, 0);
const displayName = (r) => cfg.openSource.names?.[r.repository] ?? r.repository.split("/")[1];
const searchUrl = (extra = "") =>
  `https://github.com/search?q=${encodeURIComponent(`is:pr author:${cfg.login} is:merged -user:${cfg.login}${extra}`)}&type=pullrequests`;

function layout(L) {
  const { W, mobile } = L;
  const pad = W * EDGE;
  const inner = W - 2 * pad;
  const bands = [];
  const band = (h, cells) => bands.push({ h, cells });
  const hair = (c, y) => c.add(`<rect x="${r2(pad)}" y="${r2(y)}" width="${r2(inner)}" height="1" fill="#FFFFFF" fill-opacity="0.08"/>`);
  const label = (c, x, y, s, o = {}) => c.text(x, y, s.toUpperCase(), { font: "mono", size: mobile ? 11.5 : 12.5, fill: P.muted, spacing: 1.6, ...o });

  // ---- top block
  const top = (c, y0) => {
    let y = y0 + (mobile ? 50 : 66);
    label(c, pad, y, cfg.eyebrow);
    label(c, W - pad, y, cfg.location, { anchor: "end" });

    let nameSize = mobile ? 64 : 112;
    while (measure(cfg.name + ".", "sg7", nameSize) > inner) nameSize -= 2;
    y += mobile ? nameSize * 0.95 : nameSize * 0.92;
    c.spans(pad - nameSize * 0.04, y, [{ text: cfg.name, fill: P.text }, { text: ".", fill: P.accent }], { font: "sg7", size: nameSize });

    if (mobile) {
      y += 58;
      c.text(pad, y, cfg.headline[0], { font: "sg5", size: 30 });
      c.text(pad, y + 36, cfg.headline[1], { font: "sg5", size: 30, fill: P.accent });
      y += 84;
      cfg.bio.forEach((l, i) => c.text(pad, y + i * 26, l, { size: 17, fill: P.muted }));
      y += (cfg.bio.length - 1) * 26 + 38;
    } else {
      y += 92;
      c.text(pad, y, cfg.headline[0], { font: "sg5", size: 42 });
      c.text(pad, y + 50, cfg.headline[1], { font: "sg5", size: 42, fill: P.accent });
      const by = y - 22;
      cfg.bio.forEach((l, i) => c.text(W - pad, by + i * 29, l, { size: 19, fill: P.muted, anchor: "end" }));
      y += 108;
    }
    hair(c, y);

    // toolkit
    y += mobile ? 42 : 46;
    label(c, pad, y, "Toolkit");
    const cols = mobile ? 4 : cfg.tools.length;
    const colW = inner / cols;
    const icon = mobile ? 36 : 42;
    const rowH = mobile ? 92 : 0;
    y += mobile ? 26 : 30;
    cfg.tools.forEach((t, i) => {
      const cx = pad + colW * (i % cols) + colW / 2;
      const ty = y + Math.floor(i / cols) * rowH;
      const s = icon / 24;
      c.add(`<g transform="translate(${r2(cx - icon / 2)} ${r2(ty)}) scale(${r2(s)})" fill="${P.text}" fill-opacity="0.92">${ICONS[t.slug].map((d) => `<path d="${d}"/>`).join("")}</g>`);
      c.text(cx, ty + icon + (mobile ? 24 : 30), t.name, { font: "sg5", size: mobile ? 14 : 16, fill: P.muted, anchor: "middle" });
    });
    y += Math.ceil(cfg.tools.length / cols) * (mobile ? rowH : 0) + (mobile ? 4 : icon + 66);
    hair(c, y);

    // activity
    y += mobile ? 42 : 46;
    label(c, pad, y, "GitHub activity");
    label(c, W - pad, y, `Updated ${fmtDate(activity.refreshedAt)}`, { anchor: "end", fill: P.quiet });
    y += mobile ? 58 : 66;
    const numSize = mobile ? 46 : 58;
    const num = activity.total.toLocaleString("en-US");
    c.text(pad - 2, y, num, { font: "sg7", size: numSize });
    c.text(pad + measure(num, "sg7", numSize) + (mobile ? 14 : 20), y - 4, "contributions in the last year", { size: mobile ? 16 : 19, fill: P.muted });

    const weeks = mobile ? activity.weeks.slice(-26) : activity.weeks;
    const step = inner / weeks.length;
    const cell = step * 0.8;
    const counts = activity.weeks.flat().map(([, n]) => n).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 1;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const shades = ["#FFFFFF", "#1F3B66", "#2F64B5", "#5C9BF0", "#A9D1FF"];
    y += mobile ? 26 : 30;
    const gy = y;
    weeks.forEach((wk, wi) => {
      // The first week can start mid-week; align days to their weekday row.
      const offset = wi === 0 ? 7 - wk.length : 0;
      wk.forEach(([date, n], di) => {
        const lvl = n === 0 ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4;
        const fill = lvl === 0 ? `fill="${shades[0]}" fill-opacity="0.055"` : `fill="${shades[lvl]}"`;
        c.add(`<rect x="${r2(pad + wi * step)}" y="${r2(gy + (di + offset) * step)}" width="${r2(cell)}" height="${r2(cell)}" rx="${r2(cell * 0.22)}" ${fill}><title>${date}: ${n}</title></rect>`);
      });
    });
    y = gy + 7 * step + (mobile ? 28 : 34);
    const first = weeks[0][0][0], last = weeks.at(-1).at(-1)[0];
    c.text(pad, y, `${fmtDate(first)} – ${fmtDate(last)}`, { size: mobile ? 13 : 14, fill: P.quiet });
    // legend
    const ls = mobile ? 10 : 11, lg = 4;
    let lx = W - pad - measure("More", "sg4", 14);
    c.text(lx, y, "More", { size: 14, fill: P.quiet });
    lx -= 10 + 5 * (ls + lg) - lg;
    shades.forEach((s, i) => c.add(`<rect x="${r2(lx + i * (ls + lg))}" y="${r2(y - ls + 1)}" width="${ls}" height="${ls}" rx="2.5" fill="${s}"${i === 0 ? ' fill-opacity="0.055"' : ""}/>`));
    c.text(lx - 10, y, "Less", { size: 14, fill: P.quiet, anchor: "end" });
    y += mobile ? 30 : 36;
    hair(c, y);

    // open-source header
    y += mobile ? 42 : 46;
    label(c, pad, y, `Open source · ${totalPRs} merged PRs · ${repos.length} projects`);
    y += mobile ? 44 : 50;
    c.text(pad - 1, y, "Merged contributions", { font: "sg7", size: mobile ? 30 : 38 });
    y += mobile ? 30 : 34;
    c.text(pad, y, mobile ? "Merged into projects I don't own." : "Pull requests merged into projects beyond my own repositories.", { size: mobile ? 16 : 18, fill: P.muted });
    if (!mobile) label(c, W - pad, y, "Merged pull requests", { anchor: "end" });
    return y + (mobile ? 22 : 28) - y0;
  };
  band(null, [{ frac: 1, draw: top, alt: `${cfg.name}: ${cfg.eyebrow}`, file: "profile" }]);

  // ---- one row per repository
  const rowH = mobile ? 84 : 84;
  const slotX = (i) => W * (ROW_INFO + i * ROW_CELL);
  repos.forEach((repo, ri) => {
    const name = displayName(repo);
    const slug = repo.repository.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const lang = LANG[repo.language] ?? "#8B949E";
    const cells = [];
    const sep = (c, y0) => { if (ri < repos.length - 1) hair(c, y0 + rowH - 1); };

    cells.push({
      frac: ROW_INFO, file: `${slug}-info`, alt: `${name} (${repo.repository})`,
      href: `https://github.com/${repo.repository}`, title: repo.description || repo.repository,
      draw: (c, y0) => {
        const tile = mobile ? 34 : 44;
        const ty = y0 + (rowH - tile) / 2;
        c.add(`<rect x="${r2(pad)}" y="${r2(ty)}" width="${tile}" height="${tile}" rx="${tile * 0.26}" fill="${lang}"/>`);
        c.add(`<rect x="${r2(pad)}" y="${r2(ty)}" width="${tile}" height="${tile}" rx="${tile * 0.26}" fill="url(#tileShine)"/>`);
        c.text(pad + tile / 2, ty + tile * 0.69, name[0].toUpperCase(), { font: "sg7", size: tile * 0.52, anchor: "middle", fill: lum(lang) > 0.55 ? P.ink : "#FFFFFF" });
        const tx = pad + tile + (mobile ? 10 : 16);
        const maxW = W * ROW_INFO - tx - (mobile ? 6 : 16);
        if (mobile) {
          const lines = wrap(name, "sg7", 15, maxW);
          const base = y0 + rowH / 2 + (lines.length === 1 ? 5 : -4);
          lines.forEach((l, i) => c.text(tx, base + i * 18, l, { font: "sg7", size: 15 }));
        } else {
          const starsW = 26 + measure(fmtStars(repo.stars), "mono", 12.5);
          const nm = fit(name, "sg7", 20, maxW - starsW);
          c.text(tx, y0 + rowH / 2 - 3, nm, { font: "sg7", size: 20 });
          const sx = tx + measure(nm, "sg7", 20) + 12;
          c.add(star(sx + 5, y0 + rowH / 2 - 9, 5.5, P.quiet));
          c.text(sx + 14, y0 + rowH / 2 - 4, fmtStars(repo.stars), { font: "mono", size: 12.5, fill: P.muted });
          c.text(tx, y0 + rowH / 2 + 18, fit(repo.repository, "mono", 12.5, maxW), { font: "mono", size: 12.5, fill: P.quiet });
        }
        sep(c, y0);
      },
    });

    const overflow = repo.prs.length > ROW_SLOTS;
    const shown = overflow ? repo.prs.slice(0, ROW_SLOTS - 1) : repo.prs;
    const pill = (c, y0, i, labelText, { more = false } = {}) => {
      const inset = mobile ? 4 : 7;
      const x = slotX(i) + inset, w = W * ROW_CELL - 2 * inset;
      const h = mobile ? 34 : 40, y = y0 + (rowH - h) / 2;
      c.add(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${h}" rx="${h / 2}" fill="#FFFFFF" fill-opacity="${more ? 0.02 : 0.045}" stroke="#FFFFFF" stroke-opacity="${more ? 0.1 : 0.16}"/>`);
      const fs = mobile ? 13 : 15.5;
      const tw = measure(labelText, "mono", fs);
      const iconW = mobile || more ? 0 : 22, arrW = mobile ? 0 : 18;
      let cx = x + (w - (iconW + tw + arrW)) / 2;
      if (iconW) { c.add(mergeIcon(cx, y + h / 2 - 8, 16, P.accent)); cx += iconW; }
      c.text(cx, y + h / 2 + fs * 0.36, labelText, { font: "mono", size: fs, fill: more ? P.muted : P.text });
      if (arrW) c.add(arrowUR(cx + tw + 7, y + h / 2 - 5, 9, P.muted, 1.5));
    };
    shown.forEach((pr, i) => cells.push({
      frac: ROW_CELL, file: `${slug}-pr${i}`, href: `https://github.com/${repo.repository}/pull/${pr.number}`,
      alt: `${name} merged pull request #${pr.number}`, title: pr.title,
      draw: (c, y0) => { pill(c, y0, i, `#${pr.number}`); sep(c, y0); },
    }));
    if (overflow) {
      const rest = repo.prs.length - shown.length;
      cells.push({
        frac: ROW_CELL, file: `${slug}-more`, href: searchUrl(` repo:${repo.repository}`),
        alt: `${name}: ${rest} more merged pull requests`,
        draw: (c, y0) => { pill(c, y0, ROW_SLOTS - 1, mobile ? `+${rest}` : `+${rest} more`, { more: true }); sep(c, y0); },
      });
    }
    const used = ROW_INFO + (cells.length - 1) * ROW_CELL;
    const restFrac = 1 - used;
    if (cells.length - 1 < ROW_SLOTS) {
      cells.push({ frac: restFrac, file: `${slug}-end`, alt: "", draw: (c, y0) => sep(c, y0) });
    } else {
      cells.at(-1).frac += restFrac; // the last pill also covers the right edge
    }
    band(rowH, cells);
  });

  // ---- browse all
  band(mobile ? 76 : 80, [{
    frac: 1, file: "browse-all", href: searchUrl(), alt: `Browse all ${totalPRs} merged PRs on GitHub`,
    draw: (c, y0) => {
      hair(c, y0);
      const s = mobile ? 16 : 18, t = `Browse all ${totalPRs} merged PRs on GitHub`;
      const tw = measure(t, "sg5", s);
      const x = W / 2 - (tw + 22) / 2, y = y0 + (mobile ? 46 : 48);
      c.text(x, y, t, { font: "sg5", size: s, fill: P.accent });
      c.add(arrowUR(x + tw + 10, y - s * 0.68, s * 0.62, P.accent, 1.7));
      hair(c, y0 + (mobile ? 75 : 79));
    },
  }]);

  // ---- featured projects
  band(mobile ? 104 : 116, [{
    frac: 1, file: "projects-head", alt: "Featured projects",
    draw: (c, y0) => {
      label(c, pad, y0 + (mobile ? 44 : 48), "Things I'm building");
      c.text(pad - 1, y0 + (mobile ? 84 : 94), "Featured projects", { font: "sg7", size: mobile ? 30 : 38 });
    },
  }]);
  const cardFrac = (1 - 2 * EDGE) / cfg.projects.length;
  const cardH = mobile ? 118 : 216;
  const edgeCell = (file, alt = "") => ({ frac: EDGE, file, alt, draw: () => {} });
  band(cardH, [
    edgeCell("projects-edge-l"),
    ...cfg.projects.map((p, i) => ({
      frac: cardFrac, file: `project-${i}`, href: p.url, alt: `${p.name}: ${p.lines.join(" ")}`,
      draw: (c, y0) => {
        const g = mobile ? 5 : 8;
        const x = pad + i * W * cardFrac + g, w = W * cardFrac - 2 * g, y = y0 + 4, h = cardH - 20;
        c.add(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${h}" rx="${mobile ? 14 : 18}" fill="#FFFFFF" fill-opacity="0.04" stroke="#FFFFFF" stroke-opacity="0.12"/>`);
        const ip = mobile ? 14 : 24;
        if (mobile) {
          const lines = wrap(p.name, "sg7", 16, w - 2 * ip, 2);
          lines.forEach((l, k) => c.text(x + ip, y + 34 + k * 20, l, { font: "sg7", size: 16 }));
          label(c, x + ip, y + h - 18, "View", { size: 11, fill: P.accent });
          c.add(arrowUR(x + ip + measure("VIEW", "mono", 11, 1.6) + 6, y + h - 26, 8, P.accent, 1.4));
        } else {
          const live = /build/i.test(p.status);
          if (live) c.add(`<circle cx="${r2(x + ip + 4)}" cy="${r2(y + ip + 10)}" r="4" fill="#3FB950"/>`);
          label(c, x + ip + (live ? 16 : 0), y + ip + 14, p.status, { fill: live ? "#7EE2A8" : P.muted });
          c.add(arrowUR(x + w - ip - 12, y + ip + 2, 12, P.muted, 1.6));
          c.text(x + ip, y + ip + 60, p.name, { font: "sg7", size: 26 });
          p.lines.forEach((l, k) => c.text(x + ip, y + ip + 94 + k * 24, fit(l, "sg4", 16.5, w - 2 * ip), { size: 16.5, fill: P.muted }));
          c.text(x + ip, y + h - ip, fit(p.tech, "mono", 12.5, w - 2 * ip), { font: "mono", size: 12.5, fill: P.quiet });
        }
      },
    })),
    edgeCell("projects-edge-r"),
  ]);

  // ---- call to action
  band(mobile ? 150 : 176, [{
    frac: 1, file: "call-to-action", alt: `${cfg.cta.eyebrow} ${cfg.cta.title}`,
    draw: (c, y0) => {
      hair(c, y0 + 12);
      c.text(pad, y0 + (mobile ? 64 : 72), cfg.cta.eyebrow, { size: mobile ? 17 : 21, fill: P.muted });
      const ts = mobile ? 46 : 64;
      c.text(pad - 2, y0 + (mobile ? 120 : 140), cfg.cta.title, { font: "sg7", size: ts });
      if (!mobile) label(c, W - pad, y0 + 134, cfg.cta.note, { anchor: "end", fill: P.accent });
    },
  }]);

  // ---- contact buttons
  const btnFrac = (1 - 2 * EDGE) / cfg.contact.length;
  const contactH = mobile ? 96 : 116;
  band(contactH, [
    edgeCell("contact-edge-l"),
    ...cfg.contact.map((b, i) => ({
      frac: btnFrac, file: `contact-${b.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, href: b.url, alt: b.label,
      draw: (c, y0) => {
        const g = mobile ? 4 : 8;
        const x = pad + i * W * btnFrac + g, w = W * btnFrac - 2 * g, h = mobile ? 46 : 56, y = y0 + 10;
        const fg = b.primary ? P.ink : P.text;
        c.add(`<rect x="${r2(x)}" y="${y}" width="${r2(w)}" height="${h}" rx="${h / 2}" ${b.primary ? `fill="${P.text}"` : 'fill="#FFFFFF" fill-opacity="0.04" stroke="#FFFFFF" stroke-opacity="0.18"'}/>`);
        const fs = mobile ? 15 : 18;
        const tw = measure(b.label, "sg5", fs), aw = mobile ? 0 : 18;
        const tx = x + (w - tw - aw) / 2;
        c.text(tx, y + h / 2 + fs * 0.35, b.label, { font: "sg5", size: fs, fill: fg });
        if (aw) c.add(arrowUR(tx + tw + 9, y + h / 2 - 5, 10, fg, 1.6));
      },
    })),
    edgeCell("contact-edge-r"),
  ]);

  return bands;
}

// ---------------------------------------------------------------- rendering

function renderLayout(L) {
  const bands = layout(L);
  // The top band's height is decided by its own drawing.
  if (bands[0].h == null) bands[0].h = Math.ceil(bands[0].cells[0].draw(new Canvas(), 0));
  const H = bands.reduce((n, b) => n + b.h, 0);
  const { W } = L;
  const out = [];
  let y0 = 0;
  for (const b of bands) {
    let x0 = 0;
    for (const cell of b.cells) {
      const w = cell.frac * W;
      const c = new Canvas();
      cell.draw(c, y0);
      out.push({ ...cell, svg: wrapSvg(c, x0, y0, w, b.h, W, H) });
      x0 += w;
    }
    y0 += b.h;
  }
  return out;
}

function wrapSvg(c, x, y, w, h, W, H) {
  const fonts = [...c.fonts].map((f) => `@font-face{font-family:${f};src:url(data:font/woff2;base64,${FONT_DATA[f]}) format("woff2")}`).join("");
  // Everything is drawn in whole-canvas coordinates so neighbouring slices meet seamlessly.
  const bg =
    `<defs>` +
    `<clipPath id="card"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="22"/></clipPath>` +
    `<radialGradient id="gA" gradientUnits="userSpaceOnUse" cx="${W * 0.86}" cy="${W * 0.08}" r="${W * 0.55}"><stop offset="0" stop-color="${P.glowA}" stop-opacity="0.42"/><stop offset="1" stop-color="${P.glowA}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="gB" gradientUnits="userSpaceOnUse" cx="${W * 0.05}" cy="${H * 0.42}" r="${W * 0.62}"><stop offset="0" stop-color="${P.glowB}" stop-opacity="0.2"/><stop offset="1" stop-color="${P.glowB}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="gC" gradientUnits="userSpaceOnUse" cx="${W * 0.92}" cy="${H * 0.86}" r="${W * 0.5}"><stop offset="0" stop-color="${P.glowC}" stop-opacity="0.2"/><stop offset="1" stop-color="${P.glowC}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="tileShine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.22"/><stop offset="1" stop-color="#000000" stop-opacity="0.12"/></linearGradient>` +
    `<filter id="grain" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="noStitch"/>` +
    `<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.07 0"/></filter>` +
    `</defs>` +
    `<g clip-path="url(#card)">` +
    `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${P.ink}"/>` +
    ["gA", "gB", "gC"].map((g) => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="url(#${g})"/>`).join("") +
    `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" filter="url(#grain)"/>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="22" fill="none" stroke="#FFFFFF" stroke-opacity="0.09"/>` +
    `</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(x)} ${r2(y)} ${r2(w)} ${r2(h)}" width="${r2(w)}" height="${r2(h)}">` +
    (fonts ? `<style>${fonts}</style>` : "") + bg + c.parts.join("") + `</svg>`;
}

// ---------------------------------------------------------------- output

const desktop = renderLayout({ W: 1200, mobile: false });
const mobileSlices = renderLayout({ W: 640, mobile: true });

const DIST = join(ROOT, "dist");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "panel"), { recursive: true });
const save = (name, svg) => {
  const hash = createHash("sha1").update(svg).digest("hex").slice(0, 10);
  const rel = `dist/${name.startsWith("profile") ? "" : "panel/"}${name}.${hash}.svg`;
  writeFileSync(join(ROOT, rel), svg);
  return `./${rel}`;
};

let html = "";
desktop.forEach((d, i) => {
  const m = mobileSlices[i];
  if (m.file !== d.file) throw new Error(`layout mismatch: ${d.file} vs ${m.file}`);
  const src = save(d.file, d.svg), msrc = save(`${d.file}-mobile`, m.svg);
  const width = d.frac === 1 ? "100%" : `${(d.frac * 100).toFixed(4)}%`;
  const img = `<picture><source media="(max-width: 680px)" srcset="${msrc}"><img src="${src}" alt="${esc(d.alt)}" width="${width}" align="top"></picture>`;
  html += d.href ? `<a href="${esc(d.href)}"${d.title ? ` title="${esc(d.title)}"` : ""}>${img}</a>` : img;
});

const md = (s) => String(s).replace(/([\\`*_[\]<>|])/g, "\\$1");
const plain = [
  `**${cfg.name}** · ${cfg.eyebrow} · ${cfg.location}<br>`,
  `${cfg.bio.join(" ")}`,
  "",
  `**Toolkit:** ${cfg.tools.map((t) => t.name).join(" · ")}.`,
  "",
  `**Merged open-source contributions** (${totalPRs} PRs across ${repos.length} projects):`,
  "",
  ...repos.map((r) => `- [${md(displayName(r))}](https://github.com/${r.repository}) - ${r.prs.map((p) => `[#${p.number}](https://github.com/${r.repository}/pull/${p.number}) ${md(p.title)}`).join("; ")}`),
  "",
  `**Featured projects:** ${cfg.projects.map((p) => `[${md(p.name)}](${p.url}) (${md(p.lines.join(" "))})`).join(" · ")}`,
  "",
  `**Contact:** ${[...cfg.contact, ...(cfg.extraLinks || [])].map((l) => `[${md(l.label)}](${l.url})`).join(" · ")}`,
  "",
  `**GitHub activity:** ${activity.total.toLocaleString("en-US")} contributions in the last year. Last refreshed ${fmtDate(activity.refreshedAt)}.`,
].join("\n");

const readme = `<!-- Generated by scripts/build.mjs from profile.config.json. Edit those, not this file. -->
<div align="center">
${html}
</div>

<details>
<summary>Profile in plain text</summary>

${plain}

</details>
`;
writeFileSync(join(ROOT, "README.md"), readme);
console.log(`built ${desktop.length} slices (+ mobile), ${totalPRs} PRs in ${repos.length} repos, ${activity.total} contributions`);
