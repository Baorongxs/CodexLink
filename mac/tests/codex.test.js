const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { findPageSocket, selectPageTarget } = require('../src/services/codex');

test('selectPageTarget accepts the macOS app shell and ignores devtools/overlay targets', () => {
  const selected = selectPageTarget([
    { type: 'page', title: 'DevTools', url: 'devtools://devtools', webSocketDebuggerUrl: 'ws://bad' },
    { type: 'page', title: 'avatar-overlay', url: 'file:///avatar-overlay.html', webSocketDebuggerUrl: 'ws://overlay' },
    { type: 'other', title: '', url: 'file:///Codex.app/Contents/Resources/app/index.html', webSocketDebuggerUrl: 'ws://codex' }
  ]);
  assert.equal(selected.webSocketDebuggerUrl, 'ws://codex');
});

test('findPageSocket falls back from /json/list to /json', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([
      { type: 'page', title: 'Codex', url: 'file:///index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/test' }
    ]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.equal(await findPageSocket(port), 'ws://127.0.0.1/devtools/page/test');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
