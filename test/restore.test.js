const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CoverCache } = require('../src/cover-cache');
const { CroonApi } = require('../src/api');

test('封面缓存跨实例保留，强制同步后重新获取', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'croon-cover-'));
  try {
    const cache = new CoverCache(dir);
    const revision = await cache.revision('account');
    await cache.write('book', revision, { type: 'image/png', body: Buffer.from('cover') });
    assert.equal((await new CoverCache(dir).read('book', revision)).body.toString(), 'cover');
    await cache.invalidate('account');
    const updated = await cache.revision('account');
    assert.notEqual(updated, revision);
    assert.equal(await cache.read('book', updated), undefined);
    await cache.write('book', updated, { type: 'image/jpeg', body: Buffer.from('new') });
    assert.equal((await cache.read('book', updated)).body.toString(), 'new');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('服务端版本和封面请求保留地址前缀和登录令牌', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ version: '2.1.1' }), { status: 200 });
  };
  try {
    const api = new CroonApi('https://example.com/croon', 'token', 'user');
    assert.equal(await api.serverVersion(), '2.1.1');
    await api.cover('book', 'library', '/封面.png');
    assert.equal(calls[0].url, 'https://example.com/croon/api/health');
    const url = new URL(calls[1].url);
    assert.equal(url.pathname, '/croon/api/proxy/cover');
    assert.equal(url.searchParams.get('book_id'), 'book');
    assert.equal(url.searchParams.get('library_id'), 'library');
    assert.equal(calls[1].options.headers.authorization, 'Bearer token');
  } finally {
    global.fetch = original;
  }
});
