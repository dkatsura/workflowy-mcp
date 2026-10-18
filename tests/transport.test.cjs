const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NextRequest } = require('next/server');

// Dummy credentials only. No Workflowy or database connection is made.
process.env.ADMIN_SECRET = 'test-only-admin';
process.env.MCP_ACCESS_SECRET = 'test-only-mcp';
process.env.WORKFLOWY_API_KEY = 'test-only-workflowy';
delete process.env.DATABASE_URL;
delete process.env.ALLOWED_ORIGINS;
const mcp = require('../.next/server/app/api/[transport]/route.js').routeModule.userland;
const login = require('../.next/server/app/api/admin/login/route.js').routeModule.userland;
const session = require('../.next/server/app/api/admin/session/route.js').routeModule.userland;
const base = 'https://localhost';
const context = { params: Promise.resolve({ transport: 'mcp' }) };
const request = (body, token, extraHeaders = {}) => new NextRequest(base + '/api/mcp', {
  method: 'POST',
  headers: {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});
const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

test('MCP refuses missing and invalid bearer tokens', async () => {
  for (const token of [undefined, 'wrong']) {
    assert.equal((await mcp.POST(request(rpc, token), context)).status, 401);
  }
});
test('configured Origin allowlist is enforced', async () => {
  process.env.ALLOWED_ORIGINS = base;
  assert.equal((await mcp.POST(request(rpc, 'test-only-mcp', { Origin: 'https://untrusted.example' }), context)).status, 403);
  delete process.env.ALLOWED_ORIGINS;
});
test('admin login signs a cookie and rejects tampering', async () => {
  const req = (secret) => new NextRequest(base + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }),
  });
  assert.equal((await login.POST(req('wrong'))).status, 401);
  const response = await login.POST(req('test-only-admin'));
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  const valid = await session.GET(new NextRequest(base + '/api/admin/session', { headers: { Cookie: cookie.split(';')[0] } }));
  assert.equal((await valid.json()).authenticated, true);
  const bad = await session.GET(new NextRequest(base + '/api/admin/session', { headers: { Cookie: cookie.split(';')[0] + 'tampered' } }));
  assert.equal((await bad.json()).authenticated, false);
});
test('SDK clients initialize and list tools concurrently through the built route', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const client = new Client({ name: `test-client-${i}`, version: '1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/api/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer test-only-mcp' } },
      fetch: async (url, init) => {
        const req = new NextRequest(url, init);
        return mcp[req.method](req, context);
      },
    });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      assert.equal(result.tools.length, 9);
      assert.ok(result.tools.some(tool => tool.name === 'search_nodes'));
    } finally { await client.close(); }
  }));
});

test('concurrent requests with colliding IDs keep different responses separate', async () => {
  const parse = async (response) => {
    const text = await response.text();
    const data = text.split('\n').find(line => line.startsWith('data:'));
    return JSON.parse(data ? data.slice(5) : text);
  };
  await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const isList = i % 2 === 0;
    const body = isList ? rpc : {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nonexistent_test_tool', arguments: {} },
    };
    const result = await parse(await mcp.POST(request(body, 'test-only-mcp'), context));
    assert.equal(result.id, 1);
    if (isList) assert.equal(result.result.tools.length, 9);
    else assert.ok(result.error || result.result?.isError);
  }));
});
