// Minimal HTTP API used as the factory's smoke-test fixture.
const http = require('node:http');

const routes = {
  'GET /health': () => ({ status: 200, body: { ok: true } }),
};

function handle(method, url) {
  const route = routes[`${method} ${url.split('?')[0]}`];
  return route ? route(url) : { status: 404, body: { error: 'not found' } };
}

function createServer() {
  return http.createServer((req, res) => {
    const { status, body } = handle(req.method, req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

if (require.main === module) createServer().listen(Number(process.env.PORT) || 3000);
module.exports = { handle, createServer };
