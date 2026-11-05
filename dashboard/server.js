#!/usr/bin/env node
// Live dashboard for digital-factory workflows (zero dependencies). Ways to use it:
//   wfui.sh [<workflow>]                                              finds the workflow (by path, file or name:) here, in
//                                                                     ./workflows or a subfolder; watches the intent
//                                                                     loop if its folder has .task-state/ or intents/,
//                                                                     else ./runs
//   wfui.sh --hub [--root <dir>]                                      hub: workflows running anywhere + recent runs;
//                                                                     click one to open its dashboard
//   wfui.sh run <workflow> [engine args]                              run it, log it, follow it in the hub (run.js)
//   node server.js [--repo <dir>] [--workflow <yaml>]                 intent loop: runs from <repo>/.task-state/logs
//   node server.js --workflow <yaml> --log <file>                     watch one engine log (any workflow)
//   node server.js run <yaml> [--repo <dir>] [--set k=v]... [--vars <json>] [-- <extra engine args>]
//                                                                     start the workflow and watch it
//   node server.js --runs <dir> --workflow <yaml>                     runs folder: watch <dir>/<workflow file>@<stamp>.log
//                                                                     and /workflow-execute + live-cli runs from the
//                                                                     engine database (--db <file>|off)
// Common: --port <n> (default 4777), --host <addr> (default 127.0.0.1; 0.0.0.0 in a container),
//   --outputs <dir> (repeatable: list and show the files a run changed there).
// Stage groups come from `metadata.stages` in the workflow YAML (else one stage per dependency layer). --repo defaults to the cwd.
// Read only: the workflow YAML, engine logs, the engine database (runs mode), (intent loop) .task-state/state.json + gates/test logs, --outputs dirs.
// The only file written is the engine output of `run`, kept in this app's runs/ folder.
// (The hub also keeps ~/.wfui/known.json: workflows it saw running.)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { dbReader } = require('./db.js');
const { pickWorkflow, runsDirOf, loopRepoOf, findEngine } = require('./workflows.js');

// --- CLI --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const args = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const passthrough = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
const opt = (name, def) => { const i = args.lastIndexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const optAll = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
if (args.includes('-h') || args.includes('--help')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
// Without --workflow, the workflow is found by name (file name with or without .yaml, or its `name:`) among the
// workflow YAMLs in the cwd (or --repo), ./workflows and direct subfolders; with no name, the only one found.
const VALUE_OPTS = new Set(['port', 'host', 'workflow', 'repo', 'runs', 'log', 'outputs', 'set', 'vars', 'db']);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_OPTS.has(args[i - 1].slice(2)) && args[i - 1].startsWith('--')));
// --hub (or no workflow here and none named): the hub lists running workflows anywhere instead.
if (args.includes('--hub')) { require('./hub.js'); return; }
const AUTO_WORKFLOW = args[0] !== 'run' && !opt('workflow') ? pickWorkflow(positional[0], path.resolve(opt('repo', process.cwd()))) : null;
if (AUTO_WORKFLOW === 'hub') { console.log('no workflow in this folder: starting the hub'); require('./hub.js'); return; }
// Logs to watch when no --runs/--log/--repo: the intent loop when the workflow belongs to one (its folder has
// .task-state/ or intents/, or it is a project's .intent-loop/), otherwise ./runs.
const autoLoop = AUTO_WORKFLOW && !opt('runs') && !opt('log') && !opt('repo') ? loopRepoOf(AUTO_WORKFLOW) : null;
// Runs folder: ./runs, else runs/ next to the workflow or one folder up (e.g. workflows/x.yaml + runs/), else ./runs.
const autoRunsDir = (wf) => runsDirOf(wf) || path.resolve('runs');
const AUTO_RUNS = AUTO_WORKFLOW && !autoLoop && !opt('runs') && !opt('log') && !opt('repo') ? autoRunsDir(AUTO_WORKFLOW) : null;
const MODE = args[0] === 'run' ? 'run' : opt('runs') || AUTO_RUNS ? 'runs' : opt('log') ? 'file' : 'loop';
const REPO = path.resolve(opt('repo', autoLoop || process.cwd()));
const PORT = Number(opt('port', process.env.PORT || 4777));
const HOST = opt('host', process.env.WFUI_HOST || '127.0.0.1');
const SHOWN = ['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
const resolveIn = (p) => [path.resolve(p), path.resolve(REPO, p)].find((f) => fs.existsSync(f)) || path.resolve(REPO, p);
const WORKFLOW = AUTO_WORKFLOW || resolveIn(MODE === 'run' ? args[1] || '' : opt('workflow'));
const LOG_FILE = MODE === 'file' ? path.resolve(opt('log')) : null;
const STATE_DIR = path.join(REPO, '.task-state');
const LOOP_LOG_DIR = path.join(STATE_DIR, 'logs');
const RUNS_DIR = MODE === 'runs' ? AUTO_RUNS || path.resolve(opt('runs')) : path.join(__dirname, 'runs');
// A run whose log has not grown for this long and has no summary is shown as stalled/interrupted.
const STALE_MS = 60_000;
const OUTPUT_DIRS = optAll('outputs').map((d) => path.resolve(resolveIn(d)));

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const tail = (f, n) => { const t = readText(f); return t == null ? null : stripAnsi(t).split('\n').slice(-n).join('\n'); };

// --- Workflow YAML: small indentation-aware parser, enough for the agents and tasks lists (top-level
// sections, "- key: value" items, scalar keys, inline [a, b] or "- x" lists; block scalars skipped).
function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
}
const indentOf = (l) => l.match(/^ */)[0].length;
function parseItems(lines) {
  const items = []; let cur = null; let key = null; let itemIndent = -1; let keyIndent = -1; let blockAt = -1;
  const setKey = (k, raw) => {
    key = k; const v = raw.trim();
    if (/^[|>][-+]?\d*$/.test(v)) { cur[k] = ''; blockAt = keyIndent; return; }
    blockAt = -1;
    cur[k] = v === '' ? [] : v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : unquote(v);
  };
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = indentOf(raw);
    if (blockAt >= 0 && ind > blockAt) continue;
    blockAt = -1;
    let m;
    if (itemIndent < 0 && (m = raw.match(/^( *)- /))) itemIndent = m[1].length;
    if (ind === itemIndent && (m = raw.match(/^ *- ([\w-]+):\s*(.*)$/))) {
      cur = {}; items.push(cur); keyIndent = itemIndent + 2; setKey(m[1], m[2]); continue;
    }
    if (!cur || ind < keyIndent) continue;
    if (ind === keyIndent && (m = raw.match(/^ *([\w-]+):\s*(.*)$/))) { setKey(m[1], m[2]); continue; }
    if ((m = raw.match(/^ *- (.*)$/)) && Array.isArray(cur[key]) && ind <= keyIndent + 2) cur[key].push(unquote(m[1]));
  }
  return items;
}
function parseWorkflow(file) {
  const text = readText(file);
  if (text == null) return { name: path.basename(file || 'workflow'), error: `cannot read workflow ${file}`, tasks: [] };
  const sections = {}; let name = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) { name = m[1]; sections[name] = { value: unquote(m[2]), lines: [] }; continue; }
    if (name) sections[name].lines.push(line);
  }
  const agents = Object.fromEntries(parseItems(sections.agents?.lines || []).map((a) => [a.id, a]));
  const tasks = parseItems(sections.tasks?.lines || []).filter((t) => t.id).map((t) => ({
    id: t.id,
    name: typeof t.name === 'string' && t.name && t.name !== t.id ? t.name : null,
    type: t.type === 'command' ? 'command' : t.type === 'orchestrator' ? 'orchestrator' : 'agent',
    agent: t.agent || null,
    agent_name: t.agent && typeof agents[t.agent]?.name === 'string' ? agents[t.agent].name : null,
    model: t.agent ? agents[t.agent]?.model || null : null,
    when: typeof t.when === 'string' && t.when ? t.when : null,
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : t.depends_on ? [t.depends_on] : [],
    description: typeof t.description === 'string' ? t.description : '',
  }));
  const wfName = sections.name?.value || path.basename(file, path.extname(file));
  const stages = metadataStages(sections.metadata?.lines || []);
  return { name: wfName, stagesCfg: stages, tasks: layout(tasks, stages) };
}
// Stage groups declared in the workflow itself (the engine ignores metadata); tasks by id or name. Tasks not
// listed get one stage per dependency layer, named after their tasks.
//   metadata:
//     stages:
//       - name: Prepare
//         tasks: [branch, snapshot-before-tests]
function metadataStages(lines) {
  const at = lines.findIndex((l) => /^ +stages:\s*$/.test(l));
  if (at < 0) return [];
  const ind = indentOf(lines[at]);
  const block = [];
  for (const l of lines.slice(at + 1)) { if (l.trim() && indentOf(l) <= ind) break; block.push(l); }
  return parseItems(block)
    .filter((s) => typeof s.name === 'string' && s.name)
    .map((s) => ({ name: s.name, tasks: Array.isArray(s.tasks) ? s.tasks : s.tasks ? [s.tasks] : [] }));
}

// Layer = longest path from a root; stage = configured group (metadata.stages) or one stage per layer.
function layout(tasks, stages) {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const layer = {};
  const depth = (id, seen = new Set()) => {
    if (layer[id] != null) return layer[id];
    if (seen.has(id) || !byId[id]) return 0;
    seen.add(id);
    const deps = byId[id].depends_on.filter((d) => byId[d]);
    return (layer[id] = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0);
  };
  tasks.forEach((t) => depth(t.id));
  // Transitive reduction: drop an edge a->b when b is also reachable from a through another dependency.
  const reach = {};
  const ancestors = (id, seen = new Set()) => {
    if (reach[id]) return reach[id];
    const s = new Set();
    if (seen.has(id)) return s;
    seen.add(id);
    for (const d of byId[id]?.depends_on || []) { if (!byId[d]) continue; s.add(d); ancestors(d, seen).forEach((x) => s.add(x)); }
    return (reach[id] = s);
  };
  const stageOf = {};
  (stages || []).forEach((s, i) => s.tasks.forEach((id) => { stageOf[id] = i; }));
  const extra = (stages || []).length;
  const stageIdx = (t) => stageOf[t.id] ?? (t.name != null ? stageOf[t.name] : undefined);
  const freeLayers = [...new Set(tasks.filter((t) => stageIdx(t) == null).map((t) => layer[t.id]))].sort((a, b) => a - b);
  return tasks
    .map((t) => {
      const deps = t.depends_on.filter((d) => byId[d]);
      const primary = deps.filter((d) => !deps.some((o) => o !== d && ancestors(o).has(d)));
      return { ...t, layer: layer[t.id], primary_deps: primary, stage: stageIdx(t) ?? extra + freeLayers.indexOf(layer[t.id]) };
    })
    .sort((a, b) => a.layer - b.layer);
}
function stageNames(wf) {
  const cfg = wf.stagesCfg || [];
  const n = Math.max(0, ...wf.tasks.map((t) => t.stage + 1));
  return Array.from({ length: n }, (_, i) => cfg[i]?.name || autoStageName(wf.tasks.filter((t) => t.stage === i), i + 1));
}
// Unconfigured stages are named after their tasks: "2. Load flows", "3. A & B", "4. A +2".
const humanize = (id) => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
function autoStageName(tasks, k) {
  const names = tasks.map((t) => (t.name || humanize(t.id)).replace(/^(step|phase|stage)\s*\d+\s*[:.)\-–]\s*/i, ''));
  if (!names.length) return `Step ${k}`;
  return `${k}. ${names.length <= 2 ? names.join(' & ') : `${names[0]} +${names.length - 1}`}`;
}

// --- Engine log: incremental parse (agent runs print a spinner every 0.1 s, so logs grow large).
const logCache = new Map();
function parseLog(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  let c = logCache.get(file);
  if (!c || st.size < c.offset || st.ino !== c.ino) {
    c = {
      ino: st.ino, offset: 0, rest: '', tasks: {}, order: 0, ended: false, outcome: null, summary: null, active: null, errors: [], lastFailed: null, out: [],
      // Run clock (seconds since the run started) from the engine's phase timers; progress frames and agent spans.
      clock: 0, phaseBase: 0, phaseStart: 0, frame: null, live: null, spans: {},
    };
    logCache.set(file, c);
  }
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    fs.closeSync(fd);
    c.offset = st.size;
    const lines = (c.rest + buf.toString('utf8')).split('\n');
    c.rest = lines.pop();
    for (const raw of lines) consume(c, stripAnsi(raw).replace(/\r/g, ''));
  }
  c.mtime = st.mtimeMs;
  return c;
}
// Keep a readable output tail: no spinner/progress redraws, no box borders.
function keepOutput(c, line) {
  const t = line.replace(/[│┃]/g, ' ').replace(/\s+$/, '');
  if (!t.trim() || /^[\s─━┄┌┐└┘├┤┬┴┼╭╮╰╯]+$/.test(t)) return;
  if (/⏱/.test(t) && !/completed|failed|skipped/.test(t)) return;
  if (/^\s*└─ working/.test(t)) return;
  if (/^\s*[├└]─ [\w.-]+:\s*$/.test(t)) return; // tool-call redraws without arguments
  c.out.push(t);
  if (c.out.length > 300) c.out.splice(0, c.out.length - 300);
}
// "1m07s", "17.3s", "1h2m", "250ms" -> seconds
function secs(s) {
  let t = 0, m; const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  while ((m = re.exec(s || ''))) t += Number(m[1]) * { ms: 0.001, h: 3600, m: 60, s: 1 }[m[2]];
  return t;
}
// While tasks run the engine redraws a frame every 0.1 s: "Phase N (…): ⏱ <phase elapsed>", then per running
// agent "● <agent id, or the agent name for orchestrator sub-agents> ⏱ <elapsed> [session]" and up to three
// "├─ tool: {args}" lines. A frame is complete when the next one starts.
function commitFrame(c) {
  const f = c.frame; c.frame = null;
  if (!f) return;
  c.live = f;
  // Spans per label: start = clock - elapsed. Several agents with the same label (sub-agents) are told apart
  // by their start time; agents started together are matched in order.
  const used = new Set();
  for (const b of f.blocks) {
    const start = f.clock - b.elapsed, list = (c.spans[b.label] ||= []);
    let sp = list.find((x) => !used.has(x) && x.end >= f.clock - 5 && Math.abs(x.start - start) < 3);
    if (!sp) { sp = { start, end: f.clock, last: null }; list.push(sp); }
    used.add(sp);
    sp.end = f.clock; sp.last = b.last || sp.last;
    b.span = sp;
  }
}
function consume(c, line) {
  // Progress frames are redraws (shown as live activity instead), so they stay out of the output tail.
  if (!(c.frame && /^(\s*|● .* ⏱ .*| {2}[├└]─ .*)$/.test(line))) keepOutput(c, line);
  const task = (id) => (c.tasks[id] ||= { status: 'pending', seq: c.order++ });
  let m;
  if ((m = line.match(/^Phase \d+\b.*?: ⏱ (\S+)\s*$/))) {
    commitFrame(c);
    c.clock = c.phaseStart + secs(m[1]);
    c.frame = { clock: c.clock, blocks: [] };
    return;
  }
  if (c.frame && (m = line.match(/^● (.+?) ⏱ (\S+)(?: \[([^\]]+)\])?\s*$/))) {
    c.frame.blocks.push({ label: m[1].trim(), elapsed: secs(m[2]), session: m[3] || null, now: null, last: null });
    c.active = { label: m[1].trim(), elapsed: m[2] };
    return;
  }
  if (c.frame && (m = line.match(/^ {2}[├└]─ (.*?)\s*$/))) {
    const b = c.frame.blocks[c.frame.blocks.length - 1];
    if (!b || m[1] === 'working...') return;
    if (/^[\w.-]+: \S/.test(m[1])) b.last = m[1]; else b.now = m[1].replace(/:$/, '');
    return;
  }
  if ((m = line.match(/^● Phase \d+/))) { commitFrame(c); c.live = null; c.phaseStart = c.clock = c.phaseBase; return; }
  if ((m = line.match(/^[✓✗⚠] Phase \d+.*⏱ (\S+)/))) {
    commitFrame(c); c.live = null;
    c.phaseBase = c.clock = Math.max(c.clock, c.phaseStart + secs(m[1]));
    return;
  }
  // Task lines carry the task's name when it has one (otherwise its id); snapshot() maps both.
  if ((m = line.match(/^ {2}● (.+?) \([^()]*\)(?: \[[^\]]*\])?\s*$/))) {
    const t = task(m[1]); if (t.status === 'pending') { t.status = 'running'; t.start = c.clock; }
    c.lastFailed = null; return;
  }
  if ((m = line.match(/^ {2}([✓✗]) (.+?)(?: \[([^\]]+)\])?\s*$/))) {
    const t = task(m[2]), ok = m[1] === '✓';
    Object.assign(t, { status: ok ? 'ok' : 'failed', duration: m[3] || null }, ok ? {} : { error: '' });
    t.start ??= c.clock;
    t.end = m[3] ? t.start + secs(m[3]) : c.clock;
    c.lastFailed = ok ? null : m[2]; return;
  }
  if ((m = line.match(/^ {2}⚠ (.+?) \(skipped: (.*)\)\s*$/))) { Object.assign(task(m[1]), { status: 'skipped', reason: m[2] }); c.lastFailed = null; return; }
  if ((m = line.match(/^┌.*?\b(COMPLETED|FAILED|CANCELL?ED|TIMED OUT|PARTIAL)\b/))) { c.outcome = m[1]; return; }
  if ((m = line.match(/Tasks:\s+(\d+)\/(\d+) succeeded(.*)$/))) {
    commitFrame(c); c.live = null;
    c.ended = true; c.active = null; c.lastFailed = null;
    c.summary = `${m[1]}/${m[2]} succeeded ${m[3].replace(/[│|]/g, ' ')}`.replace(/\s+/g, ' ').trim();
    return;
  }
  if (/^Error:/.test(line) || /level=ERROR/.test(line)) { c.errors.push(line.slice(0, 400)); if (c.errors.length > 5) c.errors.shift(); }
  if (c.lastFailed && line.trim() && !/^[─┄]/.test(line.trim()) && !/^[✓✗●⚠]/.test(line.trim())) {
    const t = c.tasks[c.lastFailed];
    if (t.error.length < 1500) t.error += (t.error ? '\n' : '') + line.trim();
  } else if (c.lastFailed && /^[─┄✓✗]/.test(line.trim())) {
    c.lastFailed = null;
  }
}

// --- Log sources per mode. Each entry: { key, file, id, attempt, label, mtime }.
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
const slug = (s) => String(s).replace(/[^\w.-]+/g, '_');
// Run logs are named after the workflow file (my-workflow@<stamp>.log); its name: is accepted too.
const fileSlug = () => slug(path.basename(WORKFLOW).replace(/\.ya?ml$/i, ''));
function listLogs(wfName) {
  if (MODE === 'file') {
    return [{ key: path.basename(LOG_FILE), file: LOG_FILE, id: wfName, attempt: null, label: path.basename(LOG_FILE), mtime: mtimeOf(LOG_FILE) }];
  }
  const dir = MODE === 'loop' ? LOOP_LOG_DIR : RUNS_DIR;
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.log')); } catch (_) { /* no runs folder (yet) */ }
  return files
    .map((n) => {
      const file = path.join(dir, n), mtime = mtimeOf(file);
      if (MODE === 'run' || MODE === 'runs') {
        const m = n.match(/^(.*)@(\d{8}-\d{6})\.log$/);
        if (!m || (m[1] !== fileSlug() && m[1] !== slug(wfName))) return null;
        const s = m[2], when = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}`;
        return { key: n, file, id: wfName, attempt: null, label: when, mtime };
      }
      const m = n.match(/^(.*)-(\d+)\.log$/);
      const id = m ? m[1] : n.replace(/\.log$/, ''), attempt = m ? Number(m[2]) : null;
      return { key: n, file, id, attempt, label: attempt != null ? `${id} #${attempt}` : id, mtime };
    })
    .filter(Boolean)
    .concat(MODE === 'runs' ? dbRuns() : [])
    .sort((a, b) => b.mtime - a.mtime);
}

// --- Engine database (read only): runs that write no log file. /workflow-execute (MCP) runs log task events to
// execution_events; /workflow-live-cli pools keep their jobs in channel_control/channel_status. The database is
// <engine dir>/digital-factory-rel.db: --db <file> (or WFUI_DB), else the nearest .digital-factory/ folder above
// the workflow or the cwd, else next to the engine binary. --db off disables it.
function findDb() {
  const want = opt('db', process.env.WFUI_DB);
  if (want === 'off') return null;
  if (want) return path.resolve(want);
  const cands = [], up = (d) => { for (let i = 0; i < 8; i++) { cands.push(path.join(d, '.digital-factory', 'digital-factory-rel.db')); const p = path.dirname(d); if (p === d) break; d = p; } };
  up(path.dirname(WORKFLOW)); up(process.cwd());
  const bin = findEngine(REPO);
  if (bin) { try { cands.push(path.join(path.dirname(fs.realpathSync(bin)), 'digital-factory-rel.db')); } catch (_) { /* gone */ } }
  return cands.find((f) => fs.existsSync(f)) || null;
}
const DB_FILE = MODE === 'runs' ? findDb() : null;
const dbAll = dbReader(DB_FILE, (note) => console.log(note));
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const realOf = new Map();
const real = (p) => { if (!realOf.has(p)) { try { realOf.set(p, fs.realpathSync(p)); } catch (_) { realOf.set(p, p); } } return realOf.get(p); };
// The workflow_path values in the table that are this workflow (the engine may store another spelling of it).
function dbPaths(table) {
  const me = real(WORKFLOW);
  const list = dbAll(`select distinct workflow_path p from ${table} where workflow_path like ${sq('%' + path.basename(WORKFLOW))}`).map((r) => r.p).filter((p) => real(p) === me);
  return list.length ? list.map(sq).join(',') : null;
}
const stampOf = (sec) => { const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const MAX_RUN_S = 2 * 3600; // the engine's default max_workflow_timeout: a "running" execution older than this is stalled
function dbRuns() {
  if (!DB_FILE) return [];
  const runs = [];
  // /workflow-execute: the engine keeps a wrapper (exec-<ts>) and the team execution (exec-team-…) that has the
  // task events; the wrapper is left out when its team execution is there.
  const ex = dbPaths('workflow_executions');
  if (ex) {
    const rows = dbAll(`select id, status, total_tasks, completed_tasks, failed_tasks, started_at, completed_at,
      (select max(created_at) from execution_events e where e.execution_id = x.id) last_event
      from workflow_executions x where workflow_path in (${ex}) order by started_at desc limit 50`);
    for (const r of rows) {
      if (!r.id.startsWith('exec-team-') && rows.some((o) => o.id.startsWith('exec-team-') && Math.abs(o.started_at - r.started_at) <= 3)) continue;
      const last = Math.max(r.started_at, r.completed_at || 0, r.last_event || 0);
      runs.push({ key: `db:${r.id}`, id: parseWorkflow(WORKFLOW).name, attempt: null, label: `${stampOf(r.started_at)} · workflow-execute`, mtime: last * 1000, db: { kind: 'exec', row: r } });
    }
  }
  const pool = dbPaths('channel_control');
  if (pool) for (const p of poolRuns(pool)) runs.push({ key: `db:pool:${p.jobs[0].job_id}`, id: parseWorkflow(WORKFLOW).name, attempt: null, label: `${stampOf(p.jobs[0].created_at)} · live-cli`, mtime: p.last * 1000, db: { kind: 'pool', pool: p } });
  return runs;
}
// Live-cli jobs carry the agent (queue), not the task: each job is given to the first task (in workflow order) of
// that agent whose dependencies had finished when the job was published. A job no task of the current dispatch
// can take starts the next dispatch.
function poolRuns(paths) {
  const tasks = parseWorkflow(WORKFLOW).tasks;
  const jobs = dbAll(`select c.job_id, c.queue, c.status, c.worker_id, c.created_at, s.state, s.result, s.completed_at
    from channel_control c left join channel_status s on s.job_id = c.job_id
    where c.workflow_path in (${paths}) and coalesce(c.ctl_signal, '') = '' order by c.created_at, c.rowid`);
  const runs = []; let cur = null;
  // Command tasks get no job (dispatch runs them itself): they count as finished once their own dependencies are.
  const finished = (r, id, at) => {
    const t = tasks.find((x) => x.id === id);
    if (t?.type === 'command') return t.depends_on.every((d) => finished(r, d, at));
    const dj = r.byTask[id]; return !!dj && dj.status === 'done' && dj.completed_at != null && dj.completed_at <= at;
  };
  const pick = (r, j) => tasks.find((t) => t.type !== 'command' && !r.byTask[t.id] && t.agent === j.queue && t.depends_on.every((d) => finished(r, d, j.created_at)));
  for (const j of jobs) {
    let t = cur && pick(cur, j);
    if (!t) { cur = { jobs: [], byTask: {}, last: 0 }; runs.push(cur); t = pick(cur, j); }
    cur.jobs.push(j);
    cur.last = Math.max(cur.last, j.created_at, j.completed_at || 0);
    if (t) cur.byTask[t.id] = j;
  }
  return runs.slice(-30);
}
function dbRun(entry, wf) {
  const now = Date.now() / 1000, tasks = {}, find = (id, name) => wf.tasks.find((t) => t.id === id) || wf.tasks.find((t) => name && t.name === name);
  let status, clock, summary, errors = [], live = false;
  const out = [], hhmmss = (sec) => stampOf(sec).slice(11);
  if (entry.db.kind === 'exec') {
    const r = entry.db.row, t0 = r.started_at;
    const evs = dbAll(`select event_type, task_id, task_name, tool_name, tool_args, duration_seconds, error_message, created_at
      from execution_events where execution_id = ${sq(r.id)} order by sequence_number`);
    for (const e of evs) {
      const t = find(e.task_id, e.task_name);
      if (e.event_type !== 'task_activity' || e.tool_name) {
        out.push(`${hhmmss(e.created_at)}  ${e.event_type}${e.task_id ? ` ${e.task_id}` : ''}${e.tool_name ? ` ${e.tool_name}${e.tool_args ? ': ' + String(e.tool_args).slice(0, 200) : ''}` : ''}${e.duration_seconds ? ` (${Math.round(e.duration_seconds)}s)` : ''}${e.error_message ? `\n    ${e.error_message.replace(/\n/g, '\n    ')}` : ''}`);
      }
      if (!t) { if (/^workflow_(failed|canceled)$/.test(e.event_type) && e.error_message) errors.push(e.error_message); continue; }
      const x = (tasks[t.id] ||= { status: 'pending' }), at = e.created_at - t0;
      if (e.event_type === 'task_started') Object.assign(x, { status: 'running', start: at });
      else if (e.event_type === 'task_completed' || e.event_type === 'task_failed') {
        x.start ??= at - (e.duration_seconds || 0);
        Object.assign(x, { status: e.event_type === 'task_completed' ? 'ok' : 'failed', end: at, duration: `${Math.round(at - x.start)}s` });
        if (e.event_type === 'task_failed') x.error = e.error_message || '';
      } else if (e.event_type === 'task_skipped') Object.assign(x, { status: 'skipped', reason: e.error_message || '' });
      else if (e.event_type === 'task_activity' && e.tool_name) x.activity = { now: e.tool_name, last: e.tool_args ? `${e.tool_name}: ${e.tool_args}` : null, at: e.created_at };
    }
    const last = Math.max(r.started_at, r.completed_at || 0, r.last_event || 0);
    live = r.status === 'running' && now - last < MAX_RUN_S;
    status = r.status === 'running' ? (live ? 'RUNNING' : 'STALLED') : r.status === 'canceled' ? 'CANCELLED' : String(r.status).toUpperCase();
    clock = (live ? now : r.completed_at || last) - t0;
    summary = `${r.completed_tasks}/${r.total_tasks} succeeded${r.failed_tasks ? `, ${r.failed_tasks} failed` : ''}`;
  } else {
    const p = entry.db.pool, t0 = p.jobs[0].created_at;
    const taskOf = Object.fromEntries(Object.entries(p.byTask).map(([id, j]) => [j.job_id, id]));
    const lines = [];
    for (const j of p.jobs) {
      const task = taskOf[j.job_id] ? `task ${taskOf[j.job_id]}` : 'no task';
      lines.push([j.created_at, `published to ${j.queue} (${task})${j.worker_id ? `, claimed by ${j.worker_id}` : j.status === 'open' ? ', waiting for a worker' : ''}`]);
      if (j.completed_at) lines.push([j.completed_at, `${j.state || j.status}: ${task}${j.result ? ' · ' + String(j.result).slice(0, 300) : ''}`]);
      else if (/^failed/.test(j.status)) lines.push([j.created_at, `${j.status}: ${task}`]);
    }
    lines.sort((a, b) => a[0] - b[0]).forEach(([at, l]) => out.push(`${hhmmss(at)}  ${l}`));
    for (const [id, j] of Object.entries(p.byTask)) {
      const start = j.created_at - t0;
      // Job status failed-bad-prompt (unresolved ${var} in the prompt), failed-needs-attention, …; result state failed.
      if (j.state === 'failed' || /^failed/.test(j.status)) tasks[id] = { status: 'failed', start, end: (j.completed_at || j.created_at) - t0, error: j.result || j.status };
      else if (j.status === 'done' || j.state) tasks[id] = { status: 'ok', start, end: (j.completed_at || j.created_at) - t0, duration: j.completed_at ? `${j.completed_at - j.created_at}s` : null };
      else tasks[id] = { status: 'running', start, activity: { now: j.status === 'open' ? 'waiting for a worker' : j.worker_id || 'working', at: j.created_at } };
    }
    // Command tasks: done when a task after them got a job, running while their dependencies are done.
    const after = (id) => wf.tasks.some((t) => t.depends_on.includes(id) && (tasks[t.id] || (t.type === 'command' && after(t.id))));
    for (const t of wf.tasks.filter((x) => x.type === 'command')) {
      if (after(t.id)) tasks[t.id] = { status: 'ok' };
      else if (t.depends_on.every((d) => tasks[d]?.status === 'ok') && now - p.last < STALE_MS / 1000) tasks[t.id] = { status: 'running', start: p.last - t0 };
    }
    const done = wf.tasks.filter((t) => tasks[t.id]?.status === 'ok').length, failed = wf.tasks.filter((t) => tasks[t.id]?.status === 'failed').length;
    const busy = Object.values(tasks).some((x) => x.status === 'running');
    // Between two jobs the dispatcher publishes the next one within a second or two.
    live = busy || (done + failed < wf.tasks.length && !failed && now - p.last < STALE_MS / 1000);
    status = live ? 'RUNNING' : done === wf.tasks.length ? 'COMPLETED' : failed ? 'FAILED' : 'STALLED';
    clock = (live ? now : p.last) - t0;
    summary = `${done}/${wf.tasks.length} succeeded${failed ? `, ${failed} failed` : ''}`;
  }
  for (const t of wf.tasks) {
    const x = (tasks[t.id] ||= { status: live ? 'pending' : 'not_run' });
    if (x.status === 'running' && !live) { x.status = 'stalled'; delete x.activity; }
    if (x.activity) { delete x.activity.at; x.activity.elapsed = Math.max(0, Math.round(clock - x.start)); }
    if (['ok', 'failed', 'running', 'stalled'].includes(x.status) && x.start != null) { x.end ??= clock; } else { delete x.start; delete x.end; }
  }
  const running = wf.tasks.filter((t) => tasks[t.id].status === 'running');
  return {
    key: entry.key, label: entry.label, id: entry.id, attempt: null, status, live, source: 'db',
    summary, errors, clock: Math.round(clock), updated: entry.mtime, tasks, output: out.slice(-150).join('\n'),
    active: live && running.length ? { label: running.map((t) => t.name || t.id).join(', '), elapsed: Math.round(clock - Math.min(...running.map((t) => tasks[t.id].start))) } : null,
  };
}

// --- run mode: start the engine, write its output to runs/<workflow>@<stamp>.log ----------------
const children = new Map(); // log file -> { exit: null | number }
function startRun() {
  const bin = findEngine(REPO);
  if (!bin) { console.error('digital-factory binary not found: put it on PATH or set DF_BIN'); process.exit(1); }
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const file = path.join(RUNS_DIR, `${fileSlug()}@${stamp}.log`);
  const engineArgs = ['workflow', 'run', '--allow-cross-directory', '-w', REPO];
  optAll('set').forEach((s) => engineArgs.push('--set', s));
  if (opt('vars')) engineArgs.push('--vars', path.resolve(opt('vars')));
  engineArgs.push(...passthrough, WORKFLOW);
  // Agent hosts export GIT_CONFIG_COUNT/KEY_n/VALUE_n; a half-inherited set breaks every git call.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)));
  const out = fs.openSync(file, 'a');
  const child = cp.spawn(bin, engineArgs, { cwd: REPO, env, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  const rec = { exit: null };
  children.set(file, rec);
  child.on('exit', (code, sig) => {
    rec.exit = code ?? sig;
    const p2 = parseLog(file);
    console.log(`workflow finished: ${p2?.outcome || 'ended'} (engine exit ${rec.exit})${p2?.summary ? ' · ' + p2.summary : ''}`);
    console.log(`log: ${file}   (dashboard keeps running, Ctrl+C to quit)`);
  });
  const stop = () => { if (rec.exit == null) child.kill('SIGTERM'); process.exit(130); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`started: ${path.basename(bin)} ${engineArgs.join(' ')}`);
}

// --- Snapshot ---------------------------------------------------------------------------------
function runStatus(p, child) {
  const fresh = child ? child.exit == null : Date.now() - p.mtime < STALE_MS;
  return { fresh, status: p.ended ? (p.outcome || 'ENDED') : fresh ? 'RUNNING' : child ? 'FAILED' : 'STALLED' };
}
// Whether the intent loop is running: a live pid in the tick's lock (during a tick) or in tick-loop.pid (written when
// the loop is started in the background).
function loopState() {
  const alive = (f) => { const pid = Number(readText(f)); if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  return { running: alive(path.join(STATE_DIR, 'orchestrator.lock', 'pid')) || alive(path.join(STATE_DIR, 'tick-loop.pid')) };
}
function snapshot(selected) {
  const wf = { ...parseWorkflow(WORKFLOW), file: WORKFLOW };
  let state = null; let stateError = null;
  if (MODE === 'loop') {
    const raw = readText(path.join(STATE_DIR, 'state.json'));
    if (raw) { try { state = JSON.parse(raw); } catch (e) { stateError = e.message; } }
  }
  const logs = listLogs(wf.name);
  const log = (selected && logs.find((l) => l.key === selected)) || logs[0] || null;
  let run = null;
  if (log?.db) run = dbRun(log, wf);
  else if (log) {
    const p = parseLog(log.file);
    if (p) {
      const child = children.get(log.file);
      const { fresh, status } = runStatus(p, child);
      const tasks = {};
      for (const t of wf.tasks) {
        const s = p.tasks[t.id] || (t.name && p.tasks[t.name]);
        tasks[t.id] = s ? { ...s } : { status: p.ended || !fresh ? 'not_run' : 'pending' };
        if (tasks[t.id].status === 'running' && (p.ended || !fresh)) tasks[t.id].status = 'stalled';
      }
      const running = Object.keys(tasks).filter((id) => tasks[id].status === 'running');
      // Live activity: the progress block of each running task (labelled with its agent id, or "command").
      const blocks = status === 'RUNNING' && p.live ? [...p.live.blocks] : [];
      const take = (label) => { const i = blocks.findIndex((b) => b.label === label); return i < 0 ? null : blocks.splice(i, 1)[0]; };
      for (const id of running) {
        const t = wf.tasks.find((x) => x.id === id), b = take(t.type === 'command' ? 'command' : t.agent);
        if (b) tasks[id].activity = { elapsed: b.elapsed, now: b.now, last: b.last };
      }
      // Orchestrator sub-agents: blocks labelled with the agent's name, during the task's time window.
      for (const t of wf.tasks) {
        const r = tasks[t.id];
        if (t.type !== 'orchestrator' || r.start == null || !t.agent_name) continue;
        const live = new Set(blocks.filter((b) => b.label === t.agent_name).map((b) => b.span));
        r.subagents = (p.spans[t.agent_name] || [])
          .filter((sp) => sp.start >= r.start - 3 && (r.end == null || sp.start <= r.end))
          .map((sp) => ({ start: sp.start, end: sp.end, last: sp.last, live: live.has(sp) }));
      }
      const r1 = (x) => Math.round(x * 10) / 10;
      for (const r of Object.values(tasks)) {
        if (!['ok', 'failed', 'running', 'stalled'].includes(r.status) || r.start == null) { delete r.start; delete r.end; continue; }
        r.start = r1(r.start); r.end = r1(r.end ?? p.clock);
        r.subagents?.forEach((sp) => { sp.start = r1(sp.start); sp.end = r1(sp.end); });
      }
      const since = Math.min(...running.map((id) => tasks[id].start ?? p.clock));
      const active = status === 'RUNNING' && p.active ? {
        label: running.map((id) => wf.tasks.find((t) => t.id === id).name || id).join(', ') || p.active.label,
        elapsed: running.length ? Math.max(0, Math.round((p.clock - since) * 10) / 10) : null,
      } : null;
      const errors = [...p.errors];
      if (child && child.exit != null && child.exit !== 0) errors.push(`engine exited with ${child.exit}`);
      run = {
        key: log.key, label: log.label, id: log.id, attempt: log.attempt, status, live: status === 'RUNNING',
        summary: p.summary, active, errors, clock: Math.round(p.clock * 10) / 10,
        updated: p.mtime, tasks, output: p.out.slice(-150).join('\n'),
      };
    }
  }
  const intentId = state && run && state.intents?.[run.id] ? run.id : null;
  // Run time of each intent over all its attempt logs (failed ones too; newest first), for the intents table.
  const times = {};
  if (state) for (const l of logs) {
    if (l.db || !state.intents?.[l.id]) continue;
    const p = parseLog(l.file);
    if (!p) continue;
    const t = times[l.id] ||= { secs: 0, live: false, attempts: [] }, status = runStatus(p, children.get(l.file)).status;
    t.secs += Math.round(p.clock);
    t.live ||= status === 'RUNNING';
    t.attempts.push({ attempt: l.attempt, secs: Math.round(p.clock), status });
  }
  return {
    mode: MODE,
    outputs: OUTPUT_DIRS.length > 0,
    repo: REPO,
    workflow: { name: wf.name, file: wf.file, error: wf.error || null, stages: stageNames(wf), tasks: wf.tasks },
    state: state && { base_branch: state.base_branch, critical_path: state.critical_path || [], intents: state.intents || {}, times, loop: loopState() },
    stateError,
    logs: logs.slice(0, 50).map(({ key, id, attempt, label, mtime }) => ({ key, id, attempt, label, mtime })),
    run,
    diagnostics: intentId ? { gates: tail(path.join(STATE_DIR, `gates-${intentId}.log`), 60), tests: tail(path.join(STATE_DIR, `test-${intentId}.log`), 80) } : null,
  };
}

// --- Outputs: files under the --outputs dirs modified while the selected run was going on.
const SKIP_DIR = /^(\.|node_modules$|__pycache__$|venv$)/;
function walk(dir, out, depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (out.length >= 5000) return;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name) && depth < 10) walk(f, out, depth + 1); } else if (e.isFile() && !e.name.startsWith('.')) out.push(f);
  }
}
function runWindow(log) {
  if (log.db) {
    const r = dbRun(log, parseWorkflow(WORKFLOW)), start = log.mtime - r.clock * 1000;
    return { start: start - 5000, end: r.live ? Infinity : log.mtime + 30000 };
  }
  let start;
  const m = log.key.match(/@(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)\.log$/);
  if (m) start = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  else { try { const st = fs.statSync(log.file); start = st.birthtimeMs || st.ctimeMs; } catch (_) { start = 0; } }
  const p = parseLog(log.file), child = children.get(log.file);
  const live = p && !p.ended && runStatus(p, child).fresh;
  return { start: start - 5000, end: live ? Infinity : (p?.mtime || Date.now()) + 30000 };
}
function outputs(selected) {
  const logs = listLogs(parseWorkflow(WORKFLOW).name);
  const log = (selected && logs.find((l) => l.key === selected)) || logs[0];
  if (!log) return { dirs: OUTPUT_DIRS, files: [] };
  const w = runWindow(log), files = [];
  for (const dir of OUTPUT_DIRS) {
    const all = []; walk(dir, all);
    for (const f of all) {
      let st; try { st = fs.statSync(f); } catch (_) { continue; }
      if (st.mtimeMs >= w.start && st.mtimeMs <= w.end) files.push({ path: f, rel: path.join(path.basename(dir), path.relative(dir, f)), size: st.size, mtime: st.mtimeMs });
    }
  }
  return { dirs: OUTPUT_DIRS, files: files.sort((a, b) => a.rel.localeCompare(b.rel)) };
}
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
function serveFile(res, file) {
  let real;
  try { real = fs.realpathSync(file || ''); } catch (_) { res.writeHead(404); return res.end('not found'); }
  const inside = OUTPUT_DIRS.some((d) => { try { const r = fs.realpathSync(d); return real === r || real.startsWith(r + path.sep); } catch (_) { return false; } });
  if (!inside || !fs.statSync(real).isFile()) { res.writeHead(403); return res.end('only files under --outputs dirs are served'); }
  // Served files are untrusted content: no scripts, no access to this origin.
  res.writeHead(200, { 'content-type': TYPES[path.extname(real).toLowerCase()] || 'text/plain; charset=utf-8', 'content-security-policy': 'sandbox', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(real).pipe(res);
}
// An intent's text: only the intent_file the state file names for that id, and only inside the project.
function serveIntent(res, id) {
  let state = null;
  try { state = JSON.parse(readText(path.join(STATE_DIR, 'state.json')) || 'null'); } catch (_) { /* unreadable state */ }
  const rel = MODE === 'loop' && state?.intents?.[id]?.intent_file;
  let real = null;
  try { real = rel && fs.realpathSync(path.resolve(REPO, rel)); } catch (_) { /* gone */ }
  const repo = fs.realpathSync(REPO), text = real && real.startsWith(repo + path.sep) ? readText(real) : null;
  if (text == null) { res.writeHead(404); return res.end('intent file not found'); }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

// --- HTTP: / (page), /lemmings.js (optional theme), /api/snapshot?log=, /api/events?log= (SSE, pushes a snapshot whenever it changes),
// /api/outputs?log=, /api/file?path= (read-only, only under --outputs dirs), /api/intent?id= (an intent's file, loop only).
const page = path.join(__dirname, 'index.html');
const clients = new Set();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const log = url.searchParams.get('log') || null;
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(page).pipe(res);
  }
  if (url.pathname === '/lemmings.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'lemmings.js')).pipe(res);
  }
  if (url.pathname === '/api/outputs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(outputs(log)));
  }
  if (url.pathname === '/api/file') return serveFile(res, url.searchParams.get('path'));
  if (url.pathname === '/api/intent') return serveIntent(res, url.searchParams.get('id'));
  if (url.pathname === '/api/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(snapshot(log)));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const client = { res, log, last: '' };
    clients.add(client);
    push(client);
    req.on('close', () => clients.delete(client));
    return;
  }
  res.writeHead(404); res.end('not found');
});
function push(client) {
  let body;
  try { body = JSON.stringify(snapshot(client.log)); } catch (e) { body = JSON.stringify({ fatal: e.message }); }
  if (body !== client.last) { client.last = body; client.res.write(`data: ${body}\n\n`); }
}
setInterval(() => clients.forEach(push), 1000);
setInterval(() => clients.forEach((c) => c.res.write(': ping\n\n')), 20000);

// --- Start --------------------------------------------------------------------------------------
if (optAll('workflow').length > 1) {
  console.error('one workflow per dashboard: pass a single --workflow (start another dashboard on another --port for a second one)');
  process.exit(1);
}
OUTPUT_DIRS.filter((d) => !fs.existsSync(d)).forEach((d) => console.log(`outputs dir does not exist (yet): ${d}`));
if (!fs.existsSync(WORKFLOW) || fs.statSync(WORKFLOW).isDirectory()) {
  console.error(MODE === 'run'
    ? `usage: node server.js run <workflow.yaml> [--repo <dir>] [--set k=v]... [--vars <json>] (not found: ${WORKFLOW})`
    : `workflow not found: ${WORKFLOW}\npass --workflow <yaml> (and --repo <dir> for the intent loop, --runs <dir> or --log <file> otherwise)`);
  process.exit(1);
}
if (MODE === 'file' && !fs.existsSync(LOG_FILE)) console.log(`waiting for ${LOG_FILE} to appear…`);
server.on('error', (e) => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.message} (use --port)`); process.exit(1); });
server.listen(PORT, HOST, () => {
  const what = MODE === 'loop' ? `intent loop in ${REPO}` : MODE === 'file' ? `log ${LOG_FILE}`
    : MODE === 'runs' ? `runs in ${RUNS_DIR}` : `run of ${path.basename(WORKFLOW)} in ${REPO}`;
  // The port actually bound: --port 0 (used by the hub) takes a free one.
  console.log(`workflow dashboard: http://${SHOWN}:${server.address().port}  (${what}, workflow ${WORKFLOW})`);
  if (DB_FILE) console.log(`also following /workflow-execute and live-cli runs in ${DB_FILE}`);
  if (MODE === 'run') startRun();
});
