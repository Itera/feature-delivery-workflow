// Read-only access to the engine database (digital-factory-rel.db), shared by server.js and hub.js: node:sqlite
// (Node 22.12+) when present, else the sqlite3 command-line tool.
'use strict';
const fs = require('fs');
const cp = require('child_process');

// dbReader(file, note) returns sql -> rows ([] when the file is missing or a query fails). note(message) is called
// once when neither node:sqlite nor sqlite3 is available.
function dbReader(file, note = () => {}) {
  let db = null, noted = false;
  return (sql) => {
    if (!file || !fs.existsSync(file)) return [];
    if (!db) {
      try {
        const emit = process.emitWarning;
        process.emitWarning = (w, ...a) => (/SQLite/.test(String(w)) ? undefined : emit.call(process, w, ...a));
        const { DatabaseSync } = require('node:sqlite');
        db = { kind: 'node', conn: new DatabaseSync(file, { readOnly: true }) };
      } catch (_) {
        try { cp.execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); db = { kind: 'cli' }; } catch (_) {
          if (!noted) { noted = true; note(`engine database ${file} not read: needs Node 22.12+ or the sqlite3 command`); }
          return [];
        }
      }
    }
    try {
      if (db.kind === 'node') return db.conn.prepare(sql).all();
      // -readonly needs the -shm file the engine keeps while it runs; without -wal nothing is writing, so the file
      // can be read as immutable.
      const run = (target) => cp.execFileSync('sqlite3', ['-readonly', '-json', target, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const uri = `file:${encodeURI(file).replace(/[?#]/g, encodeURIComponent)}?immutable=1`;
      let out;
      try { out = run(fs.existsSync(file + '-wal') ? file : uri); } catch (_) { out = run(uri); }
      return out.trim() ? JSON.parse(out) : [];
    } catch (_) {
      if (db.kind === 'node') { try { db.conn.close(); } catch (_) { /* closed */ } db = null; }
      return [];
    }
  };
}

module.exports = { dbReader };
