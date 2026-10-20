#!/usr/bin/env node
// task-state.js — status reporting for the intent-to-merge workflow.
// Writes intents.<task_id> into <project>/.task-state/state.json, atomically.
//
// Usage:
//   task-state.js set <task_id> key=value [key=value ...]   (dotted keys nest: verdicts.tester=GREEN)
//   task-state.js get <task_id> [key]
//   task-state.js list
//   task-state.js next [max_attempts]   (orchestrator: next eligible intent as JSON, or {action:"done"|"blocked"})
//   task-state.js sync [intents_dir]    (add intents missing from the existing state; defaults to intents_dir in state)
//   task-state.js init <intents_dir>    (create the state file from intent files; fails if it already exists)
//
// Env: PROJECT_ROOT overrides the project root (default: git toplevel of cwd, else cwd).
//      TASK_STATE_FILE overrides the state file path.
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = process.env.PROJECT_ROOT || (() => {
  try {
    return cp.execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return process.cwd(); }
})();
const STATE_FILE = process.env.TASK_STATE_FILE || path.join(ROOT, '.task-state', 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { schema_version: '1.0', loop_active: false, current: null, intents: {} };
    throw new Error(`cannot parse ${STATE_FILE}: ${e.message}`);
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

function parseValue(raw) {
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  if (keys.some((k) => !k || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new Error(`invalid key: ${dotted}`);
  }
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function main() {
  const [cmd, id, ...rest] = process.argv.slice(2);

  if (cmd === 'set') {
    if (!id || rest.length === 0) throw new Error('usage: set <task_id> key=value [key=value ...]');
    const state = readState();
    state.intents = state.intents || {};
    const entry = state.intents[id] || { phase: 'pending', status: 'pending', verdicts: {} };
    const changes = {};
    for (const pair of rest) {
      const eq = pair.indexOf('=');
      if (eq < 1) throw new Error(`bad argument (expected key=value): ${pair}`);
      setPath(entry, pair.slice(0, eq), parseValue(pair.slice(eq + 1)));
    }
    entry.updated_at = new Date().toISOString();
    state.intents[id] = entry;
    writeState(state);
    return;
  }

  if (cmd === 'get') {
    if (!id) throw new Error('usage: get <task_id> [key]');
    const entry = (readState().intents || {})[id];
    if (entry === undefined) process.exit(1);
    const out = rest[0] ? getPath(entry, rest[0]) : entry;
    if (out === undefined) process.exit(1);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'list') {
    for (const [k, v] of Object.entries(readState().intents || {})) {
      console.log(`${k}\tphase=${v.phase}\tstatus=${v.status}`);
    }
    return;
  }

  if (cmd === 'init' || cmd === 'sync') {
    // Seed the state file from a folder of intent markdown files (only if it does not exist yet).
    // Each intent file carries footer lines: **ID**: X, **Depends on**: none|X, Y, **Complexity**: ...
    // sync: add intents missing from an existing state (existing entries are never modified).
    const syncing = cmd === 'sync';
    const existing = syncing ? readState() : null;
    const dirArg = id || (syncing && existing.intents_dir);
    if (!dirArg) throw new Error(`usage: ${cmd} <intents_dir>`);
    if (!syncing && fs.existsSync(STATE_FILE)) throw new Error(`state file already exists: ${STATE_FILE}`);
    const dir = path.resolve(dirArg);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
    const companion = /_(requirements|acceptance_criteria|consistency_check|risks_complexity)\.md$/i;
    const found = {};
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md') || companion.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = text.match(/^\*\*ID\*\*:\s*(\S+)/m);
      if (!m) continue;
      const key = m[1];
      if (found[key]) throw new Error(`duplicate intent id ${key}: ${found[key].file} and ${f}`);
      const dep = (text.match(/^\*\*Depends on\*\*:\s*(.+)$/m) || [, ''])[1];
      const cx = (text.match(/^\*\*Complexity\*\*:\s*(\S+)/m) || [, null])[1];
      found[key] = { file: f, depText: dep, complexity: cx };
    }
    const ids = Object.keys(found);
    if (!ids.length) throw new Error(`no intent files with an **ID**: line found in ${dir}`);
    const lower = Object.fromEntries(ids.map((k) => [k.toLowerCase(), k]));
    for (const k of ids) {
      const deps = (found[k].depText.match(/[A-Za-z][A-Za-z0-9]*-\d+/g) || []).map((d) => {
        if (!lower[d.toLowerCase()]) throw new Error(`${k} depends on unknown intent ${d}`);
        return lower[d.toLowerCase()];
      });
      found[k].deps = [...new Set(deps)];
      if (found[k].deps.includes(k)) throw new Error(`${k} depends on itself`);
    }
    const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    const order = [];
    const known = syncing ? Object.keys(existing.intents || {}) : [];
    for (const k of known) if (found[k]) { found[k].deps = (existing.intents[k].depends_on || []); }
    const remaining = new Set(ids.sort(natural));
    while (remaining.size) {
      const next = [...remaining].find((k) => found[k].deps.every((d) => order.includes(d)));
      if (!next) throw new Error(`dependency cycle among: ${[...remaining].join(', ')}`);
      order.push(next);
      remaining.delete(next);
    }
    const rel = (p) => { const r = path.relative(ROOT, p); return r.startsWith('..') ? p : r; };
    const intents = {};
    for (const k of order) {
      if (syncing && existing.intents[k]) continue;
      const slug = found[k].file.replace(/\.md$/i, '').replace(/^.*?_intent_/i, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      intents[k] = {
        intent_file: rel(path.join(dir, found[k].file)),
        phase: 'pending',
        status: 'pending',
        complexity: found[k].complexity,
        depends_on: found[k].deps,
        branch_slug: `${k.toLowerCase()}${slug && !slug.startsWith(k.toLowerCase()) ? '-' + slug : ''}`,
        attempts: 0,
        verdicts: {},
        feedback: {},
      };
    }
    if (syncing) {
      const added = Object.keys(intents);
      if (!added.length) { console.log(JSON.stringify({ synced: 0, added: [] })); return; }
      for (const k of added) {
        const bad = intents[k].depends_on.filter((d) => !existing.intents[d] && !intents[d]);
        if (bad.length) throw new Error(`${k} depends on unknown intent ${bad.join(', ')}`);
      }
      const prev = (existing.critical_path || []).filter((k) => existing.intents[k]);
      existing.intents = { ...existing.intents, ...intents };
      existing.critical_path = [...prev, ...order.filter((k) => !prev.includes(k))];
      writeState(existing);
      console.log(JSON.stringify({ synced: added.length, added, critical_path: existing.critical_path }, null, 2));
      return;
    }
    const base = 'main';
    writeState({ schema_version: '1.0', base_branch: base, intents_dir: rel(dir), critical_path: order, intents });
    console.log(JSON.stringify({ created: STATE_FILE, intents: order.length, critical_path: order }, null, 2));
    return;
  }

  if (cmd === 'next') {
    // Orchestrator selection: first intent (critical_path order) that is not completed,
    // has all depends_on completed, and has attempts below the cap.
    const max = Number(process.env.MAX_ATTEMPTS || rest[0] || 3);
    const state = readState();
    const intents = state.intents || {};
    const order = Array.isArray(state.critical_path) && state.critical_path.length
      ? state.critical_path : Object.keys(intents);
    const done = (i) => ['completed', 'done'].includes((intents[i] || {}).status);
    const attemptsOf = (e) => (typeof e.attempts === 'number' ? e.attempts : 0);
    const waiting = [];
    for (const key of order) {
      const e = intents[key];
      if (!e) { waiting.push({ id: key, reason: 'listed in critical_path but has no intents entry' }); continue; }
      if (done(key)) continue;
      const unmet = (e.depends_on || []).filter((d) => !done(d));
      if (unmet.length) { waiting.push({ id: key, reason: `waiting on: ${unmet.join(', ')}` }); continue; }
      if (attemptsOf(e) >= max) { waiting.push({ id: key, reason: `exhausted ${attemptsOf(e)}/${max} attempts` }); continue; }
      if (!e.intent_file) { waiting.push({ id: key, reason: 'missing intent_file' }); continue; }
      console.log(JSON.stringify({
        action: 'run',
        id: key,
        intent_file: e.intent_file,
        branch_slug: e.branch_slug || key,
        base_branch: state.base_branch || 'main',
        attempt: attemptsOf(e) + 1,
        feedback: e.feedback || {},
      }, null, 2));
      return;
    }
    const pending = order.filter((k) => !done(k));
    console.log(JSON.stringify(pending.length === 0 ? { action: 'done' } : { action: 'blocked', waiting }, null, 2));
    return;
  }

  throw new Error('usage: task-state.js <set|get|list|next> ...');
}

try {
  main();
} catch (e) {
  console.error(`task-state: ${e.message}`);
  process.exit(1);
}
