import assert from 'node:assert/strict';
import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
import { neon } from '@neondatabase/serverless';
import { queryCachedNodes } from '../app/lib/search-query.ts';

loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

// One transaction, a temporary table, and synthetic data only.
// The temporary table shadows the application table for this transaction.
const queries = [
  { query: `CREATE TEMP TABLE workflowy_nodes (
    account_key TEXT, id TEXT, name TEXT, note TEXT, parent_id TEXT,
    completed BOOLEAN DEFAULT FALSE, children_count INT DEFAULT 0,
    priority INT DEFAULT 0, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  ) ON COMMIT DROP`, params: [] },
  { query: `INSERT INTO workflowy_nodes (account_key,id,name,note,completed)
    VALUES ($1,$2,$3,$4,false),($5,$6,$7,$8,false)`,
    params: ['test-owner','sample','図書館の利用案内','読書会の開催準備','other-owner','excluded','図書館の利用案内','読書会'] },
];
const captureSql = async (parts, ...params) => {
  queries.push({ query: parts.reduce((text, part, i) => text + (i ? `$${i}` : '') + part, ''), params });
  return [];
};
await queryCachedNodes(captureSql, 'test-owner', '図書館', false, 10);
await queryCachedNodes(captureSql, 'test-owner', '読書会', false, 10);

const sql = neon(process.env.DATABASE_URL);
const results = await sql.transaction(queries.map(({ query, params }) => sql(query, params)));
for (const rows of results.slice(2)) {
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sample');
}
console.log('PASS: database write/read, Japanese title/note search, account isolation; temporary table dropped.');
