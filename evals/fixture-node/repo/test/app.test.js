const test = require('node:test');
const assert = require('node:assert');
const { handle } = require('../src/app');

test('health is ok', () => {
  assert.deepStrictEqual(handle('GET', '/health'), { status: 200, body: { ok: true } });
});
test('unknown route is 404', () => {
  assert.strictEqual(handle('GET', '/nope').status, 404);
});
