#!/usr/bin/env node
// guide.mjs: the local change guide (PLAN increment 0, item 3). Deterministic: the explainer agent only writes text
// (state key `guide`, JSON); every code link here is computed from the real diff of the story branch.
//   node guide.mjs --repo <worktree> --base <ref> --state <state.json> --id <task_id> --out <file.html> [--out <file2.html>]
//                  [--github <owner/repo>]
// Links: a local one (vscode://file/<abs>:<line>) and a permalink to the story commit (blob/<sha>/<path>#L<a>-L<b>).
// The guide holds project code paths and story text: it is written only to the project's ignored local folder and the
// run folder, never committed, never linked from the PR (PLAN C8).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const outs = args.flatMap((a, i) => (a === '--out' ? [args[i + 1]] : []));
const repo = opt('repo'), base = opt('base'), stateFile = opt('state'), id = opt('id'), github = opt('github');
if (!repo || !base || !stateFile || !id || !outs.length) { console.error('usage: guide.mjs --repo --base --state --id --out [--github]'); process.exit(2); }

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const root = git('rev-parse', '--show-toplevel').trim();
const sha = git('rev-parse', 'HEAD').trim();
const entry = (JSON.parse(fs.readFileSync(stateFile, 'utf8')).intents || {})[id] || {};
const g = entry.guide;
if (!g || !Array.isArray(g.criteria)) { console.log('GUIDE=NO_TEXT'); process.exit(1); }

// --- the real diff: files, status, new-side hunks -----------------------------------------------------------
const files = new Map();   // path -> { status, add, del, hunks: [[start, end]] }
for (const l of git('diff', '--name-status', '-M', `${base}...HEAD`).split('\n').filter(Boolean)) {
  const [st, ...ps] = l.split('\t'); files.set(ps[ps.length - 1], { status: st[0], add: 0, del: 0, hunks: [] });
}
for (const l of git('diff', '--numstat', '-M', `${base}...HEAD`).split('\n').filter(Boolean)) {
  const [a, d, ...ps] = l.split('\t'); let p = ps.join('\t');
  const m = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/); if (m) p = `${m[1]}${m[3]}${m[4]}`.replace(/\/\//g, '/');
  else if (p.includes(' => ')) p = p.split(' => ')[1];
  const f = files.get(p); if (f) { f.add = Number(a) || 0; f.del = Number(d) || 0; }
}
let cur = null;
for (const l of git('diff', '--unified=0', '--no-color', '-M', `${base}...HEAD`).split('\n')) {
  if (l.startsWith('+++ ')) { cur = l === '+++ /dev/null' ? null : files.get(l.slice(6)); continue; }
  const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (h && cur) { const s = Number(h[1]), n = h[2] === undefined ? 1 : Number(h[2]); if (n > 0) cur.hunks.push([s, s + n - 1]); }
}
const lines = new Map();
const textOf = (p) => { if (!lines.has(p)) { try { lines.set(p, git('show', `HEAD:${p}`).split('\n')); } catch { lines.set(p, []); } } return lines.get(p); };

// A reference from the agent (path + optional symbol) -> a line range in the new file, or null when the path is not in
// the diff (then it is shown as "not in this change", never linked to a guessed line).
function locate(p, symbol) {
  const f = files.get(p); if (!f || f.status === 'D') return null;
  const hunkOf = (n) => f.hunks.find(([a, b]) => n >= a && n <= b);
  if (symbol) {
    const t = textOf(p); const hits = [];
    t.forEach((l, i) => { if (l.includes(symbol)) hits.push(i + 1); });
    const inHunk = hits.find((n) => hunkOf(n)); const n = inHunk || hits[0];
    if (n) { const h = hunkOf(n); return h ? [n, h[1]] : [n, n]; }
  }
  return f.hunks[0] || [1, 1];
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const local = (p, n) => `vscode://file/${encodeURI(`${root}/${p}`)}:${n}`;
const perma = (p, a, b) => (github ? `https://github.com/${github}/blob/${sha}/${encodeURI(p)}#L${a}${b > a ? `-L${b}` : ''}` : null);
const referenced = new Set();
function ref(r, kind) {
  const p = String(r.path || '').replace(/\\/g, '/').replace(/^\.\//, ''); referenced.add(p);
  const loc = locate(p, r.symbol || r.name);
  const label = `${esc(p)}${r.symbol || r.name ? ` · <code>${esc(r.symbol || r.name)}</code>` : ''}`;
  const what = esc(kind === 'test' ? r.proves : r.why);
  if (!loc) return `<li class="miss"><span class="path">${label}</span> <span class="tag">not in the diff</span><div>${what}</div></li>`;
  const [a, b] = loc, gh = perma(p, a, b);
  return `<li><a class="path" href="${local(p, a)}" title="open in the editor">${label}</a> <span class="lines">L${a}${b > a ? `–${b}` : ''}</span>`
    + `${gh ? ` <a class="gh" href="${gh}" title="permalink to the story commit">GitHub</a>` : ''}<div>${what}</div></li>`;
}

const statusTag = { met: 'ok', partly: 'warn', 'not-met': 'bad' };
const crit = g.criteria.map((c, i) => `
  <details class="crit" open data-status="${esc(c.status)}">
    <summary><span class="badge ${statusTag[c.status] || 'warn'}">${esc(c.status || '?')}</span> <b>AC${i + 1}</b> ${esc(c.text)}</summary>
    ${c.how ? `<p>${esc(c.how)}</p>` : ''}
    <div class="cols">
      <section><h4>Changes</h4><ul>${(c.changes || []).map((r) => ref(r, 'change')).join('') || '<li class="miss">none named</li>'}</ul></section>
      <section><h4>Tests that prove it</h4><ul>${(c.tests || []).map((r) => ref(r, 'test')).join('') || '<li class="miss">none named</li>'}</ul></section>
    </div>
  </details>`).join('');

const v = entry.verdicts || {};
const gates = [['test author', v.test_author], ['implementer', v.implementer], ['test gate', v.tester], ['review', v.reviewer], ['validation', v.validator]]
  .map(([k, x]) => `<tr><td>${k}</td><td><span class="badge ${/^(DONE|GREEN|CLEAR|PASS)$/.test(x) ? 'ok' : 'bad'}">${esc(x || '–')}</span></td></tr>`).join('');
const fileRows = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, f]) => {
  const h = f.hunks[0];
  const link = f.status === 'D' || !h ? esc(p) : `<a href="${local(p, h[0])}">${esc(p)}</a>${perma(p, h[0], h[1]) ? ` <a class="gh" href="${perma(p, h[0], h[1])}">GitHub</a>` : ''}`;
  return `<tr class="${referenced.has(p) ? '' : 'unmapped'}"><td>${f.status}</td><td>${link}</td><td class="num">+${f.add} −${f.del}</td><td>${referenced.has(p) ? '' : '<span class="tag">not tied to a criterion</span>'}</td></tr>`;
}).join('');
const list = (xs) => (xs && xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted">none</p>');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(id)} change guide</title><style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a66;--card:#fff;--line:#e4e1da;--ok:#1f7a4d;--warn:#a86a00;--bad:#b3261e;--link:#1d5fb4}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--mut:#a3a19b;--card:#1f1f1d;--line:#34332f;--ok:#5cc28f;--warn:#e0a640;--bad:#f2867e;--link:#8ab4f8}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1060px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
h4{margin:6px 0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}.muted{color:var(--mut)}
a{color:var(--link)}code{font:13px ui-monospace,Consolas,monospace}.crit{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
summary{cursor:pointer}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:700px){.cols{grid-template-columns:1fr}}
ul{padding-left:18px;margin:4px 0}li{margin:6px 0}li.miss{color:var(--mut)}.path{font:13px ui-monospace,Consolas,monospace}
.lines,.tag{font-size:12px;color:var(--mut)}.gh{font-size:12px}.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
td{padding:5px 10px;border-top:1px solid var(--line);vertical-align:top}.num{text-align:right;white-space:nowrap;font:13px ui-monospace,Consolas,monospace}
tr.unmapped td{background:color-mix(in srgb,var(--warn) 8%,transparent)}.filters button{font:inherit;margin-right:6px;padding:2px 10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
</style></head><body><main>
<h1>${esc(id)} · change guide</h1>
<p class="muted">Branch commit <code>${sha.slice(0, 10)}</code> against <code>${esc(base)}</code> · ${files.size} files · local only, not part of the PR</p>
<p>${esc(g.summary)}</p>
<h2>Acceptance criteria → changes → tests</h2>
<div class="filters"><button data-f="all">all</button><button data-f="partly">partly</button><button data-f="not-met">not met</button><button data-f="open">expand</button><button data-f="close">collapse</button></div>
${crit}
<h2>Gates and review</h2><table>${gates}</table>
${entry.feedback && entry.feedback.reviewer ? `<p><b>Review notes:</b> ${esc(entry.feedback.reviewer)}</p>` : ''}
<h2>Risks and review focus</h2>${list(g.risks)}
<h2>Manual checks left for the reviewer</h2>${list(g.manual_checks)}
<h2>Every changed file</h2><table>${fileRows}</table>
</main><script>
document.querySelector('.filters').addEventListener('click',e=>{const f=e.target.dataset.f;if(!f)return;
document.querySelectorAll('.crit').forEach(d=>{if(f==='open')d.open=true;else if(f==='close')d.open=false;else d.style.display=(f==='all'||d.dataset.status===f)?'':'none'})});
</script></body></html>
`;
for (const o of outs) { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, html); }
const unmapped = [...files.keys()].filter((p) => !referenced.has(p)).length;
console.log(`GUIDE=WRITTEN criteria=${g.criteria.length} files=${files.size} unmapped=${unmapped}`);
