const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AccountService } = require('../src/services/account');
const { publicMessage } = require('../src/services/util');

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString('utf8')
};

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, payload, headers = {}) {
  response.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

test('新版 New API 嵌套登录、Bearer 与刷新流程可用', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlink-auth-'));
  let refreshCount = 0;
  await withServer((request, response) => {
    if (request.url === '/api/user/login') {
      return json(response, {
        success: true,
        data: {
          user: { id: 9527, username: 'new-user', display_name: '新版用户' },
          access_token: 'old-access',
          access_expires_at: 1,
          session: { sid: 'session-new' }
        }
      }, { 'Set-Cookie': 'refresh_session=refresh-cookie; Path=/; HttpOnly' });
    }
    if (request.url === '/api/user/auth/refresh') {
      refreshCount += 1;
      assert.match(request.headers.cookie || '', /refresh_session=refresh-cookie/);
      assert.equal(request.headers['x-auth-session'], 'session-new');
      return json(response, {
        success: true,
        data: {
          user: { id: 9527 },
          access_token: 'fresh-access',
          access_expires_at: Math.floor(Date.now() / 1000) + 3600,
          session: { sid: 'session-new' }
        }
      });
    }
    if (request.url.startsWith('/api/user/self?codexlink_ts=')) {
      assert.equal(request.headers.authorization, 'Bearer fresh-access');
      assert.equal(request.headers['new-api-user'], '9527');
      assert.equal(request.headers['accept-language'], 'zh-CN,zh;q=0.9');
      assert.equal(request.headers['cache-control'], 'no-cache, no-store');
      assert.equal(request.headers.pragma, 'no-cache');
      return json(response, { success: true, data: { id: 9527, username: 'new-user', display_name: '新版用户', quota: 500000 } });
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const account = new AccountService({ sessionPath: path.join(temp, 'session.dat'), safeStorage });
    await account.login(baseUrl, 'new-user', 'password123');
    assert.equal(account.state.loggedIn, true);
    assert.equal(refreshCount, 0);
    await account.refreshBalance();
    assert.equal(account.state.userId, '9527');
    assert.equal(account.state.displayName, '新版用户');
    assert.equal(account.state.accessToken, 'fresh-access');
    assert.equal(account.state.authSessionId, 'session-new');
    assert.equal(refreshCount, 1);
  });
  fs.rmSync(temp, { recursive: true, force: true });
});

test('旧版扁平登录响应保持兼容', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlink-legacy-'));
  await withServer((request, response) => {
    if (request.url === '/api/user/login') {
      return json(response, { success: true, data: { id: 7, username: 'legacy' } }, { 'Set-Cookie': 'session=legacy-cookie; Path=/' });
    }
    if (request.url.startsWith('/api/user/self?codexlink_ts=')) {
      assert.equal(request.headers['new-api-user'], '7');
      assert.match(request.headers.cookie || '', /session=legacy-cookie/);
      assert.equal(request.headers.authorization, undefined);
      return json(response, { success: true, data: { id: 7, username: 'legacy', quota: 0 } });
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const account = new AccountService({ sessionPath: path.join(temp, 'session.dat'), safeStorage });
    await account.login(baseUrl, 'legacy', 'password123');
    assert.equal(account.state.loggedIn, true);
    await account.refreshBalance();
    assert.equal(account.state.userId, '7');
    assert.equal(account.state.accessToken, '');
  });
  fs.rmSync(temp, { recursive: true, force: true });
});

test('常见英文登录与网络错误会转为中文', () => {
  assert.equal(publicMessage('invalid credentials'), '用户名或密码错误。');
  assert.equal(publicMessage('Too Many Requests'), '操作过于频繁，请稍后再试。');
  assert.equal(publicMessage('fetch failed'), '无法连接服务器，请检查网络和服务地址。');
});

test('新版令牌列表分页参数和裸数组响应保持兼容', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlink-token-list-'));
  await withServer((request, response) => {
    assert.equal(request.url, '/api/token/?p=1&page_size=100');
    assert.equal(request.headers.origin, 'http://127.0.0.1:' + request.headers.host.split(':')[1]);
    assert.match(request.headers.referer || '', /^http:\/\/127\.0\.0\.1:/);
    return json(response, { success: true, data: [{ id: 1, name: 'GPT-PLUS-1' }] });
  }, async (baseUrl) => {
    const account = new AccountService({ sessionPath: path.join(temp, 'session.dat'), safeStorage });
    Object.assign(account.state, { loggedIn: true, baseUrl, userId: '1', accessToken: '' });
    const tokens = await account.listAllTokens();
    assert.deepEqual(tokens, [{ id: 1, name: 'GPT-PLUS-1' }]);
  });
  fs.rmSync(temp, { recursive: true, force: true });
});
