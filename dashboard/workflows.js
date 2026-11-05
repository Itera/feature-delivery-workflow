// Finding a workflow YAML by path, file name or `name:`, and the engine binary; shared by server.js, run.js and the hub.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Workflow YAMLs (files with name: and tasks:) in dir, dir/workflows, dir/.intent-loop and dir's direct subfolders.
function findWorkflows(dir) {
  const yamls = (d) => { try { return fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(d, f)); } catch (_) { return []; } };
  let subdirs = [];
  try {
    subdirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => path.join(dir, e.name));
  } catch (_) { /* unreadable cwd */ }
  return [...new Set([dir, path.join(dir, 'workflows'), path.join(dir, '.intent-loop'), ...subdirs].flatMap(yamls))].flatMap((file) => {
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
    const name = text.match(/^name:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m);
    return /^tasks:/m.test(text) && name ? [{ file, name: name[1] }] : [];
  });
}
// The workflow `wanted` names (a path, a file name with or without .yaml, or its name:) under base; with no name, the
// only one there. 'hub' when there is none and none was named; otherwise exits with the choices.
function pickWorkflow(wanted, base) {
  // A path to the YAML (anything with a folder in it, or an existing file here) is used as is.
  if (wanted && (/[\\/]/.test(wanted) || /\.ya?ml$/.test(wanted)) && fs.existsSync(wanted) && fs.statSync(wanted).isFile()) return path.resolve(wanted);
  if (wanted && /[\\/]/.test(wanted)) { console.error(`no such workflow file: ${wanted}`); process.exit(1); }
  const all = findWorkflows(base);
  const list = (wfs) => {
    const stem = (w) => path.basename(w.file, path.extname(w.file)), width = Math.max(...wfs.map((w) => stem(w).length)) + 2;
    return wfs.map((w) => `  ${stem(w).padEnd(width)}${path.relative(base, w.file)}${w.name !== stem(w) ? `  (name: ${w.name})` : ''}`).join('\n');
  };
  const hits = wanted ? all.filter((w) => [path.basename(w.file), path.basename(w.file, path.extname(w.file)), w.name].includes(wanted)) : all;
  if (hits.length === 1) return hits[0].file;
  if (!all.length && !wanted) return 'hub';
  const why = !all.length ? `no workflow YAML (a file with name: and tasks:) in ${base}, ./workflows or its subfolders`
    : !wanted ? 'several workflows here, pass one by name:' : hits.length ? `"${wanted}" matches several workflows:` : `no workflow named "${wanted}"; found:`;
  console.error(`${why}${all.length ? `\n${list(hits.length ? hits : all)}` : ''}`);
  process.exit(1);
}
// Runs folder for a workflow: ./runs, else runs/ next to the workflow or one folder up (e.g. workflows/x.yaml +
// runs/), else null.
function runsDirOf(wf) {
  return [process.cwd(), path.dirname(wf), path.dirname(path.dirname(wf))].map((d) => path.join(d, 'runs'))
    .find((d) => fs.existsSync(d) && fs.statSync(d).isDirectory()) || null;
}

// The intent loop's project for a workflow, or null: the workflow's folder when it has .task-state/ or intents/,
// or the project around an installed loop (<project>/.intent-loop/sdlc.yaml).
function loopRepoOf(wf) {
  const dir = path.dirname(wf);
  if (['.task-state', 'intents'].some((d) => fs.existsSync(path.join(dir, d)))) return dir;
  return path.basename(dir) === '.intent-loop' ? path.dirname(dir) : null;
}

// The digital-factory engine binary, or null: DF_BIN, else on the PATH, else the usual install in the home folder,
// else a .digital-factory folder in one of the parent folders of `start` or of this dashboard (an engine kept next
// to the projects). Same order as the intent loop's orchestrate-tick.sh.
function findEngine(start = process.cwd()) {
  const bin = (d) => path.join(d, '.digital-factory', 'digital-factory');
  const cands = [process.env.DF_BIN];
  try { cands.push(cp.execSync('command -v digital-factory', { encoding: 'utf8', shell: '/bin/sh', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (_) { /* not on PATH */ }
  cands.push(bin(os.homedir()));
  for (const from of [path.resolve(start), __dirname]) {
    for (let d = path.dirname(from); d !== path.dirname(d); d = path.dirname(d)) cands.push(bin(d));
  }
  return cands.find((f) => f && fs.existsSync(f)) || null;
}

module.exports = { findWorkflows, pickWorkflow, runsDirOf, loopRepoOf, findEngine };
