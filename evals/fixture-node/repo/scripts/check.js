// "Build": syntax-check every source file (stands in for a compiler).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })('src');
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`checked ${files.length} files`);
