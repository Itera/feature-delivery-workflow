#!/usr/bin/env node
// wfui.sh run <workflow> [engine args]   (or wfui.sh --hub run …): run a workflow and follow it in the hub.
//   <workflow>       a path to the YAML, or its file name / name: in the cwd, ./workflows or a subfolder
//   [engine args]    passed to `digital-factory workflow run` (--set k=v, -w <dir>, --vars <json>, -t 1h, …)
// Makes sure the hub runs (reuses the one on the port, else starts it in the background; it keeps running after the
// workflow), runs the engine with its output in runs/<workflow file>@<stamp>.log (./runs, or runs/ next to the
// workflow or one folder up, else created next to the workflow), and prints the hub link, the link to this
// workflow's dashboard, and the tasks as they start and finish. Ctrl+C stops the workflow, not the hub.
// Env: WFUI_PORT (hub port, default 4777), WFUI_HOST (default 0.0.0.0 in a container, else 127.0.0.1),
//      WFUI_URL (the hub's address as users open it, e.g. http://localhost:3001 when the port is published as another
//      one; default http://localhost:<port>), DF_BIN (engine binary).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { pickWorkflow, runsDirOf, findEngine } = require('./workflows.js');

const args = process.argv.slice(2);
if (!args.length || args[0] === '-h' || args[0] === '--help') {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.length ? 0 : 1);
}
const [wanted, ...engineArgs] = args;
const found = pickWorkflow(wanted, process.cwd());
if (found === 'hub') { console.error('no workflow found here: pass its name or the path to its YAML'); process.exit(1); }
const WORKFLOW = fs.realpathSync(found);
const text = fs.readFileSync(WORKFLOW, 'utf8');
const NAME = text.match(/^name:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m)?.[1] || path.basename(WORKFLOW);

const IN_CONTAINER = fs.existsSync('/run/.containerenv') || fs.existsSync('/.dockerenv');
const PORT = Number(process.env.WFUI_PORT || 4777);
const HOST = process.env.WFUI_HOST || (IN_CONTAINER ? '0.0.0.0' : '127.0.0.1');
const URL_BASE = (process.env.WFUI_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// The hub names a workflow by its YAML path (hub.js idOf).
const LINK = `${URL_BASE}/w/${Buffer.from(WORKFLOW).toString('base64url')}/`;

// Colours only on a terminal (not when piped or with NO_COLOR).
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr('1'), dim = sgr('2'), cyan = sgr('36'), green = sgr('32'), red = sgr('31'), yellow = sgr('33'), url = sgr('1;4;36');
const rule = (title = '') => `━━${title}`.padEnd(Math.min(process.stdout.columns || 80, 100), '━');

// --- Hub: the one answering on the port, else a new one in the background.
const isHub = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/list', timeout: 2000 }, (res) => {
    let body = ''; res.on('data', (d) => (body += d));
    res.on('end', () => { try { resolve(Array.isArray(JSON.parse(body).workflows)); } catch (_) { resolve(false); } });
  });
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
});
const portFree = () => new Promise((resolve) => {
  const s = require('net').createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(PORT, '127.0.0.1');
});
async function ensureHub() {
  if (await isHub()) return { started: false };
  if (!(await portFree())) { console.error(`port ${PORT} is used by something other than the hub: set WFUI_PORT to another port`); process.exit(1); }
  const log = path.join(os.homedir(), '.wfui', `hub-${PORT}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  // Its own session, so Ctrl+C here does not stop it. --root: recent runs are looked up from here.
  const hub = cp.spawn(process.execPath, [path.join(__dirname, 'hub.js'), '--port', String(PORT), '--host', HOST, '--root', process.cwd()],
    { cwd: process.cwd(), stdio: ['ignore', out, out], detached: true });
  hub.unref(); fs.closeSync(out);
  for (let i = 0; i < 50 && !(await isHub()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await isHub())) { console.error(`the hub did not start: see ${log}`); process.exit(1); }
  return { started: true, pid: hub.pid, log };
}

async function main() {
  const bin = findEngine();
  if (!bin) { console.error('digital-factory binary not found: put it on PATH or set DF_BIN'); process.exit(1); }
  const runsDir = runsDirOf(WORKFLOW) || path.join(path.dirname(WORKFLOW), 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const log = path.join(runsDir, `${path.basename(WORKFLOW).replace(/\.ya?ml$/i, '').replace(/[^\w.-]+/g, '_')}@${stamp}.log`);
  const hub = await ensureHub();

  // The info block, framed and coloured apart from the task lines that follow.
  const row = (label, value) => console.log(`   ${dim(label.padEnd(10))}${value}`);
  const more = (text) => console.log(`   ${' '.repeat(10)}${text}`);
  console.log(cyan(rule(' wfui run ')));
  console.log(` ${bold(`▶ ${NAME}`)}`);
  row('workflow', WORKFLOW);
  row('log', log);
  row('hub', `${url(`${URL_BASE}/`)}  ${dim(hub.started ? `(started now, pid ${hub.pid}; its output: ${hub.log})` : '(already running)')}`);
  row('this run', url(LINK));
  if (!IN_CONTAINER) row('ports', dim(`the hub listens on ${HOST}:${PORT} (every workflow goes through it; WFUI_PORT to change)`));
  else if (process.env.WFUI_URL) {
    row('ports', dim(`the hub listens on port ${PORT} in this container (every workflow goes through it),`));
    more(dim(`reached from outside as ${URL_BASE} (WFUI_URL)`));
  } else {
    row('ports', dim(`the hub listens on port ${PORT} in this container (every workflow goes through it).`));
    more(dim(`To open it from outside, publish that port when the container is created (podman run -p ${PORT}:${PORT} …);`));
    more(dim('if it is published as another port, set WFUI_URL (e.g. WFUI_URL=http://localhost:3001) for these links.'));
  }
  console.log(cyan(rule()));
  console.log(dim(' tasks'));

  // The engine's output goes to the log (the dashboard reads it); the terminal shows the tasks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)));
  const extra = engineArgs.includes('--allow-cross-directory') || engineArgs.includes('-allow-cross-directory') ? [] : ['--allow-cross-directory'];
  const out = fs.openSync(log, 'a');
  const engine = cp.spawn(bin, ['workflow', 'run', ...extra, ...engineArgs, WORKFLOW], { stdio: ['ignore', out, out], env });
  fs.closeSync(out);
  // The hub lists runs it sees in the process list only while someone has it open: record this one where it
  // looks too (hub.js known), so its link works after the run as well.
  try {
    const store = path.join(os.homedir(), '.wfui', 'known.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    let known = {}; try { known = JSON.parse(fs.readFileSync(store, 'utf8')); } catch (_) { /* first one */ }
    known[WORKFLOW] = { ...known[WORKFLOW], cwd: process.cwd(), log, seen: Date.now() };
    fs.writeFileSync(store, JSON.stringify(known, null, 2));
  } catch (_) { /* best effort */ }

  let offset = 0, rest = '', summary = null;
  const seen = new Set();
  const follow = () => {
    let buf;
    try { const st = fs.statSync(log); if (st.size <= offset) return; buf = Buffer.alloc(st.size - offset); const fd = fs.openSync(log, 'r'); fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = st.size; } catch (_) { return; }
    const lines = (rest + buf.toString('utf8')).split(/\r?\n|\r/);
    rest = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[│┃]/g, ' ').trimEnd();
      let m;
      if ((m = line.match(/^ {2}● (.+?) \(([^()]*)\)(?: \[[^\]]*\])?$/)) || (m = line.match(/^ {2}([✓✗]) (.+)$/)) || (m = line.match(/^ {2}⚠ (.+ \(skipped: .*\))$/))) {
        if (!seen.has(line)) { seen.add(line); console.log((/^ {2}●/.test(line) ? yellow : /^ {2}✓/.test(line) ? green : /^ {2}✗/.test(line) ? red : dim)(line)); }
      } else if ((m = line.match(/Tasks:\s+(\d+\/\d+ succeeded.*)$/))) summary = m[1].replace(/\s+/g, ' ').trim();
      else if (/^Error:/.test(line)) console.log(red(`  ${line}`));
    }
  };
  const timer = setInterval(follow, 1000);
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) { engine.kill('SIGKILL'); return; }
    stopping = true; console.log(yellow('\n  stopping the workflow (Ctrl+C again to force)…')); engine.kill('SIGINT');
  });
  engine.on('exit', (code, signal) => {
    clearInterval(timer); follow();
    const ok = code === 0 && !signal && !stopping && !/ [1-9]\d* failed/.test(summary || '');
    console.log(cyan(rule()));
    console.log(` ${(ok ? green : red)(bold(`■ ${summary || (signal || stopping ? 'stopped' : code ? `engine exited with ${code}` : 'finished')}`))}`);
    row('this run', url(LINK));
    row('hub', `${url(`${URL_BASE}/`)}  ${dim('(keeps running)')}`);
    process.exit(code ?? 1);
  });
}
main();
