// Workflow hub: lists digital-factory workflows running anywhere on this machine (from the process list and the
// engine databases) and recent runs (from the engine's .digital-factory/events folders and databases); clicking one
// opens its dashboard under /w/<id>/ on the hub's own port (a server.js on a free local port, proxied), so one
// published port is enough in a container. Started by `wfui.sh --hub`, or by wfui.sh where no workflow is found.
//   --port <n> (default 4777)   --host <addr> (default 127.0.0.1; 0.0.0.0 in a container)   --root <dir> (scanned for .digital-factory/, default the cwd)
// Remembers workflows it saw running in ~/.wfui/known.json, so they stay listed after the run.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { dbReader } = require('./db.js');
const { loopRepoOf, findEngine } = require('./workflows.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.lastIndexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PORT = Number(opt('port', process.env.PORT || 4777));
const HOST = opt('host', process.env.WFUI_HOST || '127.0.0.1');
const SHOWN = ['0.0.0.0', '::'].includes(HOST) ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
const ROOT = path.resolve(opt('root', process.cwd()));
const STORE = path.join(os.homedir(), '.wfui', 'known.json');
const SERVER = path.join(__dirname, 'server.js');

const sh = (cmd, a) => {
  try { return cp.execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch (e) { return e.stdout || ''; }
};
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };
const real = (f) => { try { return fs.realpathSync(f); } catch (_) { return f; } };
const idOf = (yaml) => Buffer.from(yaml).toString('base64url');
const wfName = (yaml) => {
  try { return fs.readFileSync(yaml, 'utf8').match(/^name:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m)?.[1] || null; } catch (_) { return null; }
};

// --- Remembered workflows: { "<yaml>": { log, cwd, seen } }. `wfui.sh run` (run.js) adds its runs to the file too,
// so it is read again when it changes.
let known = readJson(STORE, {}), knownAt = 0;
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
function reloadKnown() {
  const at = mtimeOf(STORE);
  if (at !== knownAt) { known = readJson(STORE, known); knownAt = at; }
}
function remember(yaml, info) {
  reloadKnown();
  const prev = known[yaml] || {};
  const next = { ...prev, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v != null)) };
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  known[yaml] = next;
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(known, null, 2)); knownAt = mtimeOf(STORE); } catch (_) { /* best effort */ }
}

// --- Running engines: `digital-factory workflow run ... <yaml>` processes.
function processes() {
  return sh('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command=']).split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], start: Date.parse(m[4]), cmd: m[5] }] : [];
  });
}
// Open files: /proc on Linux (containers often have no lsof), lsof elsewhere.
const PROC = fs.existsSync('/proc/self/fd');
const link = (p) => { try { return fs.readlinkSync(p); } catch (_) { return null; } };
const cwdOf = (pid) => (PROC ? link(`/proc/${pid}/cwd`) : lsof([pid], ['-d', 'cwd'])[0]?.name || null);
// lsof -F records: [{ pid, fd, type, dev, name, access }]
function lsof(pids, extra = []) {
  if (!pids.length) return [];
  const recs = []; let pid = null; let cur = null;
  for (const l of sh('lsof', ['-n', '-P', '-w', '-a', '-p', pids.join(','), ...extra, '-F', 'pfatdn']).split('\n')) {
    const k = l[0], v = l.slice(1);
    if (k === 'p') pid = +v;
    else if (k === 'f') recs.push((cur = { pid, fd: v }));
    else if (cur && k === 't') cur.type = v;
    else if (cur && k === 'd') cur.dev = v;
    else if (cur && k === 'n') cur.name = v;
    else if (cur && k === 'a') cur.access = v.trim();
  }
  return recs;
}
// The engine's stdout: a file, or a pipe into a process of the same group (tee, server.js run) that writes a log.
function logOf(engine, procs) {
  const group = () => procs.filter((p) => p.pid !== engine.pid && (p.pgid === engine.pgid || p.ppid === engine.ppid));
  if (PROC) {
    const out = link(`/proc/${engine.pid}/fd/1`);
    if (!out) return null;
    if (out.startsWith('/')) return out.startsWith('/dev/') ? null : out;
    if (!/^pipe:\[\d+\]$/.test(out)) return null;
    // The reader has the pipe as its stdin (tee); its log is the file it has open.
    const reader = group().find((p) => link(`/proc/${p.pid}/fd/0`) === out);
    if (!reader) return null;
    let fds = []; try { fds = fs.readdirSync(`/proc/${reader.pid}/fd`); } catch (_) { return null; }
    const files = fds.map((fd) => link(`/proc/${reader.pid}/fd/${fd}`)).filter((f) => f?.startsWith('/') && !/^\/(dev|proc)\//.test(f));
    return files.find((f) => /\.log$/.test(f)) || files[0] || null;
  }
  const out = lsof([engine.pid], ['-d', '1'])[0];
  if (!out) return null;
  if (out.type === 'REG') return out.name;
  if (out.type !== 'PIPE' || !out.name?.startsWith('->')) return null;
  const peer = out.name.slice(2);
  const recs = lsof(group().map((p) => p.pid));
  const reader = recs.find((r) => r.type === 'PIPE' && r.dev === peer)?.pid;
  if (!reader) return null;
  const files = recs.filter((r) => r.pid === reader && r.type === 'REG' && /[wu]/.test(r.access || '') && !r.name.startsWith('/dev/'));
  return (files.find((f) => /\.log$/.test(f.name)) || files[0])?.name || null;
}
const engineCache = new Map();
function running() {
  const procs = processes();
  const engines = procs.filter((p) => {
    const t = p.cmd.split(/\s+/), w = t.indexOf('workflow');
    return path.basename(t[0]) === 'digital-factory' && w > 0 && t[w + 1] === 'run' && !t.includes('--dry-run');
  });
  const pids = new Set(engines.map((e) => e.pid));
  for (const pid of engineCache.keys()) if (!pids.has(pid)) engineCache.delete(pid);
  return engines.filter((e) => !pids.has(e.ppid)).flatMap((e) => {
    let info = engineCache.get(e.pid);
    if (!info || !info.log) {
      const cwd = info?.cwd || cwdOf(e.pid);
      const arg = e.cmd.split(/\s+/).filter((a) => /\.ya?ml$/.test(a)).pop();
      if (!arg || !cwd) return [];
      info = { pid: e.pid, start: e.start, cwd, yaml: path.resolve(cwd, arg), log: logOf(e, procs) };
      engineCache.set(e.pid, info);
      remember(info.yaml, { cwd, log: info.log, seen: Date.now() });
    }
    return [info];
  });
}

// --- Finished runs: <dir>/.digital-factory/events/*_{completed,failed}.json (written by the engine).
// scan() also collects the engine databases: <dir>/.digital-factory/digital-factory-rel.db, ~/.digital-factory and
// the one next to the engine binary.
let eventDirs = []; let dbFiles = []; let scannedAt = 0;
function scan() {
  const found = new Set(), dbs = new Set();
  const engineDir = (d) => {
    if (isDir(path.join(d, 'events'))) found.add(path.join(d, 'events'));
    if (fs.existsSync(path.join(d, 'digital-factory-rel.db'))) dbs.add(real(path.join(d, 'digital-factory-rel.db')));
  };
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.digital-factory') { engineDir(path.join(d, e.name)); continue; }
      if (depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(d, e.name), depth - 1);
    }
  };
  walk(ROOT, 5);
  for (const [yaml, k] of Object.entries(known)) {
    for (const d of [path.dirname(yaml), k.cwd]) if (d) engineDir(path.join(d, '.digital-factory'));
  }
  engineDir(path.join(os.homedir(), '.digital-factory'));
  const bin = findEngine(ROOT);
  if (bin) engineDir(path.dirname(real(bin)));
  eventDirs = [...found]; dbFiles = [...dbs]; scannedAt = Date.now();
}
const eventCache = new Map();
// A moved workflow keeps its old path in earlier events: use the same-named workflow in the folder that
// holds the events (or its workflows/ subfolder), if there is one.
function relocate(yaml, name, dir) {
  if (fs.existsSync(yaml)) return yaml;
  for (const d of [dir, path.join(dir, 'workflows')]) {
    let files; try { files = fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)); } catch (_) { continue; }
    const same = files.map((f) => path.join(d, f)).filter((f) => wfName(f) === name);
    const exact = same.find((f) => path.basename(f) === path.basename(yaml));
    if (exact || same.length === 1) return exact || same[0];
  }
  return yaml;
}
function finishedRuns() {
  if (Date.now() - scannedAt > 60_000) scan();
  const runs = [];
  for (const dir of eventDirs) {
    let files; try { files = fs.readdirSync(dir).filter((f) => /_(completed|failed)\.json$/.test(f)); } catch (_) { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      if (!eventCache.has(file)) {
        const e = readJson(file, null);
        eventCache.set(file, e?.workflow?.path ? {
          yaml: relocate(e.workflow.path, e.workflow.name, path.dirname(path.dirname(dir))), name: e.workflow.name, at: Date.parse(e.timestamp), status: e.status === 'completed' ? 'COMPLETED' : 'FAILED',
          duration: e.duration_seconds, tasks: e.task_count, ok: e.success_count,
        } : null);
      }
      if (eventCache.get(file)) runs.push(eventCache.get(file));
    }
  }
  return runs;
}

// --- Runs started from Claude/Copilot (/workflow-execute, /workflow-live-cli) write no log: they are in the engine
// databases (see server.js dbRuns, which shows them per task).
const MAX_RUN_S = 2 * 3600; // the engine's default max_workflow_timeout: a "running" execution older than this is stalled
const STALE_S = 60; // live-cli: the dispatcher publishes the next job within seconds of the last one
const readers = new Map();
function dbRuns() {
  if (Date.now() - scannedAt > 60_000) scan();
  const now = Date.now() / 1000, runs = [];
  for (const file of dbFiles) {
    if (!readers.has(file)) readers.set(file, dbReader(file, (note) => console.log(note)));
    const all = readers.get(file);
    // /workflow-execute: a wrapper execution (exec-<ts>) and the team execution (exec-team-…); one run each.
    const ex = all(`select id, status, workflow_path, started_at, completed_at, total_tasks, completed_tasks, failed_tasks,
      (select max(created_at) from execution_events e where e.execution_id = x.id) last_event
      from workflow_executions x order by started_at desc limit 300`);
    for (const r of ex) {
      if (!r.id.startsWith('exec-team-') && ex.some((o) => o.id.startsWith('exec-team-') && o.workflow_path === r.workflow_path && Math.abs(o.started_at - r.started_at) <= 3)) continue;
      const last = Math.max(r.started_at, r.completed_at || 0, r.last_event || 0);
      const live = ['running', 'initialization'].includes(r.status) && now - last < MAX_RUN_S;
      runs.push({ yaml: r.workflow_path, db: file, source: 'workflow-execute', live, start: r.started_at * 1000, at: last * 1000,
        status: r.status === 'completed' ? 'COMPLETED' : r.status === 'canceled' ? 'CANCELLED' : live ? 'RUNNING' : 'FAILED',
        duration: last - r.started_at, tasks: r.total_tasks, ok: r.completed_tasks });
    }
    // /workflow-live-cli: jobs per workflow; live while a job is unfinished or the last one is a few seconds old.
    const pools = all(`select c.workflow_path, min(c.created_at) first, max(c.created_at) published, max(coalesce(s.completed_at, 0)) completed,
      sum(case when s.state is null and c.status <> 'done' and c.status not like 'failed%' then 1 else 0 end) open,
      sum(case when s.state = 'failed' or c.status like 'failed%' then 1 else 0 end) failed, count(*) jobs
      from channel_control c left join channel_status s on s.job_id = c.job_id
      where coalesce(c.ctl_signal, '') = '' group by c.workflow_path`);
    for (const p of pools) {
      const last = Math.max(p.published, p.completed);
      const live = (p.open > 0 && now - last < MAX_RUN_S) || now - last < STALE_S;
      runs.push({ yaml: p.workflow_path, db: file, source: 'live-cli', live, start: p.first * 1000, at: last * 1000,
        status: live ? 'RUNNING' : p.failed ? 'FAILED' : 'COMPLETED', duration: last - p.first, jobs: p.jobs });
    }
  }
  return runs;
}

// --- List
function list() {
  reloadKnown();
  const rows = new Map();
  const row = (file) => {
    const yaml = real(file);
    if (!rows.has(yaml)) rows.set(yaml, { id: idOf(yaml), yaml, name: wfName(yaml) || path.basename(yaml), exists: fs.existsSync(yaml), running: [], last: null, runs: 0 });
    return rows.get(yaml);
  };
  for (const r of running()) row(r.yaml).running.push({ pid: r.pid, start: r.start, cwd: r.cwd, log: r.log });
  for (const r of finishedRuns()) {
    if (!fs.existsSync(r.yaml) && !rows.has(r.yaml)) continue;
    const w = row(r.yaml); w.runs++; (w.ended ||= []).push(r.at);
    if (!w.last || r.at > w.last.at) w.last = r;
  }
  for (const r of dbRuns()) {
    if (!path.isAbsolute(r.yaml) || !fs.existsSync(r.yaml)) continue;
    const w = row(r.yaml); w.db = r.db;
    if (r.live) { w.running.push({ start: r.start, source: r.source }); continue; }
    // A /workflow-execute run that also wrote a completion event is already counted.
    if (w.ended?.some((at) => Math.abs(at - r.at) < 120_000)) continue;
    w.runs++;
    if (!w.last || r.at > w.last.at) w.last = r;
  }
  for (const yaml of Object.keys(known)) if (fs.existsSync(yaml)) row(yaml);
  for (const w of rows.values()) {
    const c = children.get(w.id);
    w.dashboard = c && c.proc.exitCode == null ? `w/${w.id}/` : null;
    w.loop = isLoop(w.yaml);
  }
  const at = (w) => (w.running.length ? 1e15 + Math.max(...w.running.map((r) => r.start)) : w.last?.at || known[w.yaml]?.seen || 0);
  return [...rows.values()].sort((a, b) => at(b) - at(a));
}

// --- Dashboards: one server.js per workflow on a free local port, served by the hub under /w/<id>/.
const children = new Map();
const isLoop = (yaml) => !!loopRepoOf(yaml);
function dashboardArgs(w) {
  const args = logArgs(w);
  // Runs mode also follows the database the hub found this workflow's runs in.
  return w.db && args[0] === '--runs' ? [...args, '--db', w.db] : args;
}
function logArgs(w) {
  const dir = path.dirname(w.yaml), k = known[w.yaml] || {};
  if (isLoop(w.yaml)) return ['--repo', loopRepoOf(w.yaml), '--workflow', w.yaml];
  const log = w.running.find((r) => r.log)?.log || (w.running.some((r) => r.source) ? null : k.log);
  // Run logs are named after the workflow file or its name: (see server.js listLogs).
  const prefixes = [`${path.basename(w.yaml).replace(/\.ya?ml$/i, '')}@`, `${w.name}@`];
  const stamped = (d) => { try { return fs.readdirSync(d).some((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.log')); } catch (_) { return false; } };
  if (log && /@\d{8}-\d{6}\.log$/.test(log)) return ['--runs', path.dirname(log), '--workflow', w.yaml];
  const candidates = [w.running[0]?.cwd, k.cwd, dir, path.dirname(dir)].filter(Boolean).map((d) => path.join(d, 'runs'));
  const runsDir = candidates.find(stamped);
  if (runsDir) return ['--runs', runsDir, '--workflow', w.yaml];
  if (log) return ['--log', log, '--workflow', w.yaml];
  return ['--runs', candidates.find(isDir) || path.join(dir, 'runs'), '--workflow', w.yaml];
}
function startDashboard(w) {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(process.execPath, [SERVER, ...dashboardArgs(w), '--port', '0', '--host', '127.0.0.1'], { cwd: path.dirname(w.yaml), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => {
      out += d;
      const m = out.match(/workflow dashboard: http:\/\/\S+:(\d+)/);
      if (m) { proc.stdout.off('data', onData); resolve({ proc, port: Number(m[1]) }); }
    };
    proc.stdout.on('data', onData); proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', () => reject(new Error(out.trim() || 'dashboard exited')));
  });
}
const starting = new Map();
async function dashboard(id) {
  const c = children.get(id);
  if (c && c.proc.exitCode == null) return c;
  // Requests that arrive while it starts (the page and its scripts) wait for the same dashboard.
  if (!starting.has(id)) {
    const w = list().find((x) => x.id === id);
    if (!w) throw new Error('unknown workflow');
    starting.set(id, startDashboard(w).then((s) => { children.set(id, s); return s; }).finally(() => starting.delete(id)));
  }
  return starting.get(id);
}
// Forward a request to a dashboard, streaming both ways (its live updates are Server-Sent Events).
function proxy(req, res, port, to) {
  const up = http.request({ host: '127.0.0.1', port, path: to, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`dashboard not reachable: ${e.message}`); });
  res.on('close', () => up.destroy());
  req.pipe(up);
}
const stopChildren = () => { for (const c of children.values()) c.proc.kill(); };
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// --- HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'hub.html')));
    if (url.pathname === '/api/list') return send(200, 'application/json', JSON.stringify({ root: ROOT, home: os.homedir(), now: Date.now(), workflows: list() }));
    if (url.pathname === '/api/rescan' && req.method === 'POST') { scan(); return send(200, 'application/json', '{}'); }
    // A workflow's dashboard: /w/<id>/… (relative links, so it needs the trailing slash; /open/<id> is the old form).
    const m = url.pathname.match(/^\/(?:w|open)\/([\w-]+)(\/.*)?$/);
    if (m) {
      if (!m[2] || url.pathname.startsWith('/open/')) { res.writeHead(302, { Location: `/w/${m[1]}/${url.search}` }); return res.end(); }
      let d; try { d = await dashboard(m[1]); } catch (e) { return send(500, 'text/plain; charset=utf-8', `cannot open dashboard: ${e.message}`); }
      return proxy(req, res, d.port, m[2] + url.search);
    }
    send(404, 'text/plain', 'not found');
  } catch (e) { send(500, 'text/plain', String(e.message)); }
});
server.on('error', (e) => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.message} (use --port)`); process.exit(1); });
server.listen(PORT, HOST, () => {
  scan();
  console.log(`workflow hub: http://${SHOWN}:${PORT}  (running workflows anywhere; recent runs under ${ROOT})`);
});
