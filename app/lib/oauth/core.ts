import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Sql = (parts: TemplateStringsArray, ...values: any[]) => Promise<any[]>;
export const SCOPE = 'workflowy';
export const ACCESS_SECONDS = 3600;
export const REFRESH_SECONDS = 30 * 24 * 3600;
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function sign(value: object, key: string, purpose: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(`${purpose}:${payload}`).digest('base64url')}`;
}
export function unsign(value: string, key: string, purpose: string): any {
  const parts = value.split('.');
  if (parts.length !== 2 || value.length > 16000) throw new OAuthError('invalid_request');
  const expected = createHmac('sha256', key).update(`${purpose}:${parts[0]}`).digest('base64url');
  if (!equal(parts[1], expected)) throw new OAuthError('invalid_request');
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString()); }
  catch { throw new OAuthError('invalid_request'); }
}
export function allowedRedirect(uri: string): boolean {
  // Exact stable ChatGPT callback; callback-specific URLs use one bounded path segment.
  return uri === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
    /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(uri);
}
export function registerClient(body: any, key: string) {
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 5 ||
      body.redirect_uris.some((uri: unknown) => typeof uri !== 'string' || !allowedRedirect(uri))) {
    throw new OAuthError('invalid_redirect_uri');
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata');
  if (body.grant_types && (!Array.isArray(body.grant_types) || body.grant_types.some((x: unknown) => !['authorization_code', 'refresh_token'].includes(String(x))))) throw new OAuthError('invalid_client_metadata');
  if (body.response_types && (!Array.isArray(body.response_types) || body.response_types.some((x: unknown) => x !== 'code'))) throw new OAuthError('invalid_client_metadata');
  const metadata = { redirect_uris: body.redirect_uris as string[], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'ChatGPT', scope: SCOPE };
  // Signed public client IDs are stateless registrations, not credentials or grants.
  return { ...metadata, client_id: sign({ redirects: metadata.redirect_uris, nonce: randomToken() }, key, 'client'), client_id_issued_at: Math.floor(Date.now()/1000) };
}
export function clientRedirects(id: string, key: string): string[] {
  try {
    const data = unsign(id, key, 'client');
    if (!Array.isArray(data.redirects) || !data.redirects.length || data.redirects.some((x: any) => typeof x !== 'string' || !allowedRedirect(x))) throw new Error();
    return data.redirects;
  } catch { throw new OAuthError('invalid_client', 401); }
}
export type Authorization = { client: string; redirect: string; resource: string; scope: string; state: string; challenge: string };
export function authorization(params: URLSearchParams, key: string, resource: string): Authorization {
  for (const field of ['client_id','redirect_uri','response_type','resource','scope','state','code_challenge','code_challenge_method']) {
    if (params.getAll(field).length > 1) throw new OAuthError('invalid_request');
  }
  const client = params.get('client_id') || '', redirect = params.get('redirect_uri') || '';
  if (!clientRedirects(client, key).includes(redirect)) throw new OAuthError('invalid_redirect_uri');
  if (params.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type');
  if (params.get('resource') !== resource) throw new OAuthError('invalid_target');
  const scopes = (params.get('scope') || SCOPE).split(' ').filter(Boolean);
  if (!scopes.includes(SCOPE) || scopes.some(x => ![SCOPE, 'offline_access'].includes(x))) throw new OAuthError('invalid_scope');
  const pkce = params.get('code_challenge') || '', state = params.get('state') || '';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(pkce) || state.length > 2048) throw new OAuthError('invalid_request');
  return { client, redirect, resource, scope: [...new Set(scopes)].join(' '), state, challenge: pkce };
}
export async function schema(sql: Sql) {
  await sql`CREATE TABLE IF NOT EXISTS workflowy_oauth_grants (
    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL, scope TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL, challenge TEXT NOT NULL,
    code_expires TIMESTAMPTZ NOT NULL, code_used BOOLEAN NOT NULL DEFAULT FALSE,
    access_hash TEXT UNIQUE, access_expires TIMESTAMPTZ, refresh_hash TEXT UNIQUE,
    refresh_expires TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS workflowy_oauth_used_refresh (
    token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES workflowy_oauth_grants(id) ON DELETE CASCADE
  )`;
  await sql`CREATE TABLE IF NOT EXISTS workflowy_oauth_attempts (
    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at TIMESTAMPTZ NOT NULL
  )`;
}
export async function issueCode(sql: Sql, owner: string, auth: Authorization) {
  const code = randomToken(), id = randomToken();
  await sql`INSERT INTO workflowy_oauth_grants (id,owner_key,client_id,redirect_uri,resource,scope,code_hash,challenge,code_expires,refresh_expires)
    VALUES (${id},${owner},${auth.client},${auth.redirect},${auth.resource},${auth.scope},${hash(code)},${auth.challenge},now()+interval '5 minutes',now()+interval '30 days')`;
  return code;
}
export async function exchange(sql: Sql, owner: string, params: URLSearchParams, key: string, resource: string) {
  for (const field of ['client_id','grant_type','code','code_verifier','redirect_uri','resource','refresh_token','scope']) {
    if (params.getAll(field).length > 1) throw new OAuthError('invalid_request');
  }
  const client = params.get('client_id') || '';
  clientRedirects(client, key);
  if (params.get('resource') !== resource) throw new OAuthError('invalid_target');
  const access = `wf_at_${randomToken()}`, refresh = `wf_rt_${randomToken()}`;
  let rows: any[];
  if (params.get('grant_type') === 'authorization_code') {
    const code = params.get('code') || '', verifier = params.get('code_verifier') || '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new OAuthError('invalid_grant');
    rows = await sql`UPDATE workflowy_oauth_grants SET code_used=TRUE,access_hash=${hash(access)},access_expires=now()+interval '1 hour',refresh_hash=${hash(refresh)}
      WHERE code_hash=${hash(code)} AND owner_key=${owner} AND client_id=${client} AND redirect_uri=${params.get('redirect_uri') || ''}
      AND resource=${resource} AND challenge=${challenge(verifier)} AND code_expires>now() AND NOT code_used AND NOT revoked RETURNING scope`;
    if (!rows.length) {
      // An already redeemed code is a replay: revoke the issued grant, never mint twice.
      await sql`UPDATE workflowy_oauth_grants SET revoked=TRUE WHERE code_hash=${hash(code)} AND owner_key=${owner} AND client_id=${client} AND code_used AND challenge=${challenge(verifier)}`;
    }
  } else if (params.get('grant_type') === 'refresh_token') {
    const old = params.get('refresh_token') || '';
    if (!/^wf_rt_[A-Za-z0-9_-]{43}$/.test(old)) throw new OAuthError('invalid_grant');
    rows = await sql`WITH rotated AS (
      UPDATE workflowy_oauth_grants SET access_hash=${hash(access)},access_expires=now()+interval '1 hour',refresh_hash=${hash(refresh)}
      WHERE refresh_hash=${hash(old)} AND owner_key=${owner} AND client_id=${client} AND resource=${resource}
        AND refresh_expires>now() AND NOT revoked AND (${params.get('scope')}::text IS NULL OR scope=${params.get('scope')}) RETURNING id,scope
    ), remembered AS (INSERT INTO workflowy_oauth_used_refresh(token_hash,grant_id) SELECT ${hash(old)},id FROM rotated RETURNING grant_id)
    SELECT scope FROM rotated`;
    if (!rows.length) {
      await sql`UPDATE workflowy_oauth_grants SET revoked=TRUE WHERE owner_key=${owner} AND client_id=${client} AND id IN
        (SELECT grant_id FROM workflowy_oauth_used_refresh WHERE token_hash=${hash(old)})`;
    }
  } else throw new OAuthError('unsupported_grant_type');
  if (!rows.length) throw new OAuthError('invalid_grant');
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: rows[0].scope };
}
export async function verifyAccess(sql: Sql, owner: string, token: string, resource: string) {
  if (!/^wf_at_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await sql`SELECT client_id,scope FROM workflowy_oauth_grants WHERE access_hash=${hash(token)} AND owner_key=${owner}
    AND resource=${resource} AND access_expires>now() AND refresh_expires>now() AND code_used AND NOT revoked`;
  return rows[0]?.scope.split(' ').includes(SCOPE) ? rows[0] : null;
}
export async function revokeToken(sql: Sql, owner: string, token: string, client: string) {
  await sql`UPDATE workflowy_oauth_grants SET revoked=TRUE WHERE owner_key=${owner} AND client_id=${client} AND
    (access_hash=${hash(token)} OR refresh_hash=${hash(token)} OR id IN (SELECT grant_id FROM workflowy_oauth_used_refresh WHERE token_hash=${hash(token)}))`;
}
