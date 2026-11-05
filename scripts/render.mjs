#!/usr/bin/env node
// factory render: template @ this commit + projects/<p>/adapter.json + projects/<p>/overrides/  ->  projects/<p>/generated/
//   node scripts/render.mjs <project>            write generated files
//   node scripts/render.mjs <project> --check    exit 1 if the committed generated files differ (CI drift check)
// Fixed rules are not parameters; they are checked on the rendered result, after overrides, and a violation refuses the render.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [project, flag] = process.argv.slice(2);
if (!project) { console.error('usage: render.mjs <project> [--check]'); process.exit(2); }
const pdir = path.join(ROOT, 'projects', project);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const die = (m) => { console.error(`render: ${m}`); process.exit(1); };

// 1 · adapter: schema-valid, setup only
const adapter = JSON.parse(read(path.join(pdir, 'adapter.json')));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(read(path.join(ROOT, 'schemas', 'adapter.schema.json'))));
if (!validate(adapter)) die(`adapter invalid:\n${validate.errors.map((e) => `  ${e.instancePath || '/'} ${e.message}`).join('\n')}`);
if (adapter.project.id !== project) die(`adapter project.id ${adapter.project.id} != folder ${project}`);

// 2 · workflow: placeholders
const get = (dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), adapter);
// "{{GATE <cmd> [args]}}" fills a whole quoted command. Order for story-git.sh: <cmd> <task> <branch> <base> [args].
// Non-greedy up to the closing }}" so a last argument ending in } (${tasks.x.output?}) stays intact.
const GATE = (cmd, args) =>
  'git -C ${factory} show ${trust}:scripts/launch.sh | sh -s -- ${factory} ${trust} ${git_meta} ${project} ${run_dir} ${repo_path} '
  + `${cmd} \${task_id} \${branch} \${base_branch}${args}`;
let wf = read(path.join(ROOT, 'workflows', 'delivery.yaml'));
wf = wf.replace(/"\{\{GATE ([a-z-]+)(.*?)\}\}"/g, (_, cmd, args) => `"${GATE(cmd, args)}"`);
wf = wf.replace(/\{\{([a-z_]+(?:\.[a-z_]+)+)\}\}/g, (_, key) => {
  let v = get(key);
  if (Array.isArray(v)) v = v.length ? v.join(', ') : 'none';
  if (v === undefined || v === null || typeof v === 'object') die(`template needs adapter value ${key}`);
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
});
const left = wf.match(/\{\{[^}]*\}\}/);
if (left) die(`unresolved placeholder ${left[0]}`);

// 3 · prompts: template, then overrides (a whole file, same name, with a header saying why)
const prompts = {};
for (const f of fs.readdirSync(path.join(ROOT, 'prompts'))) prompts[f] = read(path.join(ROOT, 'prompts', f));
const odir = path.join(pdir, 'overrides', 'prompts');
const overrides = [];
if (fs.existsSync(odir)) {
  for (const f of fs.readdirSync(odir)) {
    const text = read(path.join(odir, f));
    if (!/^<!-- override: .+ \| \d{4}-\d{2}-\d{2} \| .+ -->/.test(text)) die(`override ${f} needs a header <!-- override: <why> | <date> | <run or story> -->`);
    if (!prompts[f]) die(`override ${f} has no template prompt to replace`);
    prompts[f] = text; overrides.push(`prompts/${f}`);
  }
}

// 4 · fixed rules on the final result (chapter 3 of the spec), not on the inputs
const agent = (id) => (wf.split(/\n  - id: /).find((b) => b.startsWith(`${id}\n`)) || '');
const rules = [
  ['acceptance tests are locked for the implementer', /Edit\(.*\)/.test(agent('implementer')) && agent('implementer').includes(`Edit(${adapter.tests.acceptance_glob})`)],
  ['verifiers are read-only', ['reviewer', 'pr-writer', 'reporter', 'tester'].every((a) => /denied_tools:[^\n]*\bWrite\b[^\n]*\bEdit\b/.test(agent(a)))],
  ['every agent declares its tool surface', ['test-author', 'tester', 'implementer', 'reviewer', 'validator', 'pr-writer', 'reporter'].every((a) => /allowed_tools:/.test(agent(a)) && /"mcp__\*"/.test(agent(a)))],
  ['deterministic gates present', ['lock-tests', 'run-tests', 'gate-test', 'gate-review', 'full-tests', 'gate-validate', 'publish'].every((t) => wf.includes(`- id: ${t}\n`))],
  ['publish only after validation passed', /- id: publish\n[\s\S]*?when: "\$\{tasks\.gate-validate\.output\?\} == PASS"/.test(wf)],
  ['no merge step (human merge)', !/- id: merge\n/.test(wf) || adapter.merge.mode !== 'human'],
  ['no reviewers requested (pilot)', (adapter.publish.reviewers || []).length === 0],
];
const broken = rules.filter(([, ok]) => !ok).map(([n]) => n);
if (broken.length) die(`fixed rules violated after overrides: ${broken.join('; ')}`);

// 5 · trusted config read by the gates (git show <trust>:projects/<p>/generated/config.json)
const config = {
  project: adapter.project, repo: { github: adapter.repo.github }, git: { story_base: adapter.git.story_base, local_dir: adapter.git.local_dir || '.itera', commit: adapter.git.commit },
  commands: adapter.commands, tests: adapter.tests, publish: adapter.publish, disclosure: adapter.disclosure,
  platform: { os: (adapter.platform && adapter.platform.os) || '' },
};
const commit = (() => { try { return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const header = `# GENERATED by scripts/render.mjs — do not edit. template=${adapter.template_version} adapter=${sha(JSON.stringify(adapter))} overrides=[${overrides.join(',')}]\n`;
const out = {
  'delivery.yaml': header + wf,
  'config.json': JSON.stringify(config, null, 2) + '\n',
  ...Object.fromEntries(Object.entries(prompts).map(([f, t]) => [`prompts/${f}`, t])),
};

const gdir = path.join(pdir, 'generated');
if (flag === '--check') {
  const drift = Object.entries(out).filter(([f, t]) => !fs.existsSync(path.join(gdir, f)) || read(path.join(gdir, f)) !== t).map(([f]) => f);
  if (drift.length) die(`generated files differ from a fresh render: ${drift.join(', ')} (run: node scripts/render.mjs ${project})`);
  console.log(`render: ${project} up to date`);
} else {
  fs.rmSync(gdir, { recursive: true, force: true });
  for (const [f, t] of Object.entries(out)) { fs.mkdirSync(path.dirname(path.join(gdir, f)), { recursive: true }); fs.writeFileSync(path.join(gdir, f), t); }
  console.log(`render: ${project} -> projects/${project}/generated (${Object.keys(out).length} files, overrides: ${overrides.length || 'none'}, rendered at ${commit})`);
}
