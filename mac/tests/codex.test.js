const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  buildLaunchArgs,
  findBundleProcessIds,
  findPageSocket,
  selectAvailableDebugPort,
  selectPageTarget
} = require('../src/services/codex');

test('selectPageTarget accepts the macOS app shell and ignores devtools/overlay targets', () => {
  const selected = selectPageTarget([
    { type: 'page', title: 'DevTools', url: 'devtools://devtools', webSocketDebuggerUrl: 'ws://bad' },
    { type: 'page', title: 'avatar-overlay', url: 'file:///avatar-overlay.html', webSocketDebuggerUrl: 'ws://overlay' },
    { type: 'other', title: '', url: 'file:///Codex.app/Contents/Resources/app/index.html', webSocketDebuggerUrl: 'ws://codex' }
  ]);
  assert.equal(selected.webSocketDebuggerUrl, 'ws://codex');
});

test('selectPageTarget rejects the ChatGPT startup error data page', () => {
  const selected = selectPageTarget([
    { type: 'page', title: 'ChatGPT failed to start', url: 'data:text/html;charset=utf-8,%3Ch1%3ESomething%20went%20wrong%3C/h1%3E', webSocketDebuggerUrl: 'ws://error' },
    { type: 'other', title: 'Codex', url: 'file:///Codex.app/Contents/Resources/app/index.html', webSocketDebuggerUrl: 'ws://codex' }
  ]);
  assert.equal(selected.webSocketDebuggerUrl, 'ws://codex');
});

test('macOS launch reopens one LaunchServices instance instead of forcing a second instance', () => {
  const args = buildLaunchArgs('/Applications/ChatGPT.app', 9230);
  assert.deepEqual(args.slice(0, 3), ['-a', '/Applications/ChatGPT.app', '--args']);
  assert.equal(args.includes('-n'), false);
  assert.equal(args.includes('-na'), false);
  assert.equal(args.includes('-F'), false);
  assert.ok(args.includes('--remote-debugging-port=9230'));
  assert.equal(args.some((item) => String(item).startsWith('data:')), false);
});

test('bundle process scan includes helpers and descendants but excludes unrelated Codex CLI', () => {
  const ids = findBundleProcessIds(`
  100     1 /Applications/Codex.app/Contents/MacOS/ChatGPT --remote-debugging-port=9230
  101   100 /Applications/Codex.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper
  102   101 /usr/bin/helper-child
  200     1 /usr/local/bin/codex
  201     1 /Applications/Other.app/Contents/MacOS/Other /Applications/Codex.app
  202     1 /Applications/Other.app/Contents/MacOS/Other /Applications/Codex.app/Contents/Resources/file
  `, '/Applications/Codex.app');
  assert.deepEqual(ids, [102, 101, 100]);
});

test('occupied debug port falls back to a free loopback port', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const occupied = server.address().port;
    const selected = await selectAvailableDebugPort(occupied);
    assert.notEqual(selected, occupied);
    assert.ok(selected >= 1024 && selected <= 65535);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('start button and route switching both use the guarded single-instance restart flow', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /if \(!alreadyStopped\) await codex\.stop\(\);/);
  assert.match(main, /startCodex\(payload, true, true\)/);
  assert.match(main, /startCodex\(\{\}, true, true\)/);
  assert.match(main, /codex\.start\(\{ debugPort: requestedPort, alreadyStopped: true \}\)/);
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
