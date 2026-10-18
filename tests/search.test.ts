import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore Node's built-in TypeScript runner requires the extension.
import { queryCachedNodes } from '../app/lib/search-query.ts';

const db = new PGlite();
const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
  const query = parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, '');
  return (await db.query(query, values)).rows;
};
const search = (query: string, completed = false, limit = 100) =>
  queryCachedNodes(sql, 'owner', query, completed, limit);

before(async () => {
  await db.exec(`CREATE TABLE workflowy_nodes (
    account_key TEXT, id TEXT, name TEXT, note TEXT, parent_id TEXT,
    completed BOOLEAN DEFAULT FALSE, children_count INT DEFAULT 0,
    priority INT DEFAULT 0, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`);
  const fixtures = [
    ['owner', 'jp', '図書館の利用案内', '読書会の開催準備', false],
    ['owner', 'en', 'Project meeting notes', null, false],
    ['owner', 'done', '図書館', null, true],
    ['other', 'private', '図書館', '読書会', false],
    ['owner', 'literal', '100%_done', null, false],
  ];
  for (const row of fixtures) {
    await db.query('INSERT INTO workflowy_nodes (account_key,id,name,note,completed) VALUES ($1,$2,$3,$4,$5)', row);
  }
});
after(async () => { await db.close(); });

test('Japanese substring in a title and note', async () => {
  assert.deepEqual((await search(' 図書館 ')).map((r: any) => r.id), ['jp']);
  assert.deepEqual((await search('読書会')).map((r: any) => r.id), ['jp']);
});
test('English full-text terms still work', async () => {
  assert.deepEqual((await search('project notes')).map((r: any) => r.id), ['en']);
});
test('completed filter and account isolation', async () => {
  assert.deepEqual((await search('図書館', true)).map((r: any) => r.id).sort(), ['done', 'jp']);
});
test('SQL and wildcard characters are literal input', async () => {
  assert.deepEqual(await search("' OR TRUE --"), []);
  assert.deepEqual((await search('%_')).map((r: any) => r.id), ['literal']);
});
test('limit applies to results', async () => {
  assert.equal((await search('図書館', true, 1)).length, 1);
});
test('blank input is rejected before querying', () => {
  assert.throws(() => search('  '), /non-whitespace/);
});
