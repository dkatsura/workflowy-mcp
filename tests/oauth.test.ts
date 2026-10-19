import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore Node type stripping requires explicit extensions.
import { schema, registerClient, authorization, randomToken, challenge, hash, issueCode, exchange, verifyAccess, revokeToken, sign, unsign } from '../app/lib/oauth/core.ts';
const db = new PGlite();
const sql = async (parts: TemplateStringsArray, ...values: any[]) => {
  const query = parts.reduce((text, part, i) => text+(i ? `$${i}` : '')+part,'');
  return (await db.query(query,values)).rows;
};
const key='test-only-admin-key', owner='test-owner', resource='https://mcp.example/api/mcp';
const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
const client=registerClient({redirect_uris:[redirect]},key).client_id;
function fixture() {
  const verifier=randomToken();
  const params=new URLSearchParams({client_id:client,redirect_uri:redirect,resource,scope:'workflowy offline_access',state:'state-to-echo',response_type:'code',code_challenge:challenge(verifier),code_challenge_method:'S256'});
  return {verifier,params,auth:authorization(params,key,resource)};
}
async function grant() {
  const f=fixture(), code=await issueCode(sql,owner,f.auth);
  const params=new URLSearchParams({client_id:client,redirect_uri:redirect,resource,grant_type:'authorization_code',code,code_verifier:f.verifier});
  return {...f,params,code};
}
const redeem=(params:URLSearchParams)=>exchange(sql,owner,params,key,resource);
const refresh=(token:string)=>new URLSearchParams({grant_type:'refresh_token',refresh_token:token,resource,client_id:client});
before(async()=>{await schema(sql);});
after(async()=>{await db.close();});
test('DCR rejects external redirects, deceptive hosts, fragments, queries, and unsupported auth',()=>{
  for(const url of ['https://evil.example/cb','https://chatgpt.com.evil.example/connector_platform_oauth_redirect',redirect+'?x=1',redirect+'#x','http://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com@evil.example/cb']){
    assert.throws(()=>registerClient({redirect_uris:[url]},key));
  }
  assert.throws(()=>registerClient({redirect_uris:[redirect],token_endpoint_auth_method:'client_secret_post'},key));
});
test('authorization binds client, exact redirect, resource and S256 PKCE',()=>{
  for(const [field,value] of [['client_id',client+'x'],['redirect_uri','https://evil.example'],['resource','https://other.example/api/mcp'],['code_challenge_method','plain'],['scope','other']]){
    const {params}=fixture();params.set(field,value);assert.throws(()=>authorization(params,key,resource));
  }
  const {params}=fixture();params.append('resource',resource);assert.throws(()=>authorization(params,key,resource));
});
test('signed consent payloads reject modification and cross-purpose reuse',()=>{
  const proof=sign({nonce:'n',params:'q'},key,'csrf');
  assert.equal(unsign(proof,key,'csrf').nonce,'n');
  assert.throws(()=>unsign(proof+'x',key,'csrf'));
  assert.throws(()=>unsign(proof,key,'client'));
});
test('successful authorization exchange stores only token hashes and validates owner/audience',async()=>{
  const {params}=await grant();const tokens=await redeem(params);
  assert.equal(tokens.expires_in,3600);
  assert.ok(await verifyAccess(sql,owner,tokens.access_token,resource));
  assert.equal(await verifyAccess(sql,'other-owner',tokens.access_token,resource),null);
  assert.equal(await verifyAccess(sql,owner,tokens.access_token,'https://other.example'),null);
  const rows=await sql`SELECT access_hash,refresh_hash FROM workflowy_oauth_grants WHERE access_hash=${hash(tokens.access_token)}`;
  assert.equal(rows[0].refresh_hash,hash(tokens.refresh_token));
  assert.notEqual(rows[0].access_hash,tokens.access_token);
});
test('wrong PKCE, client, redirect, or resource cannot redeem a code',async()=>{
  const {params}=await grant();
  const otherClient=registerClient({redirect_uris:[redirect]},key).client_id;
  for(const [field,value] of [['code_verifier',randomToken()],['client_id',otherClient],['redirect_uri',redirect+'x'],['resource','https://other.example']]){
    const bad=new URLSearchParams(params);bad.set(field,value);await assert.rejects(()=>redeem(bad));
  }
  assert.ok((await redeem(params)).access_token);
});
test('authorization code expires and cannot be used twice; replay revokes tokens',async()=>{
  const expired=await grant();
  await sql`UPDATE workflowy_oauth_grants SET code_expires=now()-interval '1 second' WHERE code_hash=${hash(expired.code)}`;
  await assert.rejects(()=>redeem(expired.params));
  const {params}=await grant();const tokens=await redeem(params);
  await assert.rejects(()=>redeem(params));
  assert.equal(await verifyAccess(sql,owner,tokens.access_token,resource),null);
});
test('concurrent code exchanges issue at most one token pair',async()=>{
  const {params}=await grant();
  const results=await Promise.allSettled([redeem(params),redeem(params)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('refresh rotates tokens; replay revokes the complete grant',async()=>{
  const {params}=await grant();const first=await redeem(params);
  const second=await redeem(refresh(first.refresh_token));
  assert.equal(await verifyAccess(sql,owner,first.access_token,resource),null);
  assert.ok(await verifyAccess(sql,owner,second.access_token,resource));
  await assert.rejects(()=>redeem(refresh(first.refresh_token)));
  assert.equal(await verifyAccess(sql,owner,second.access_token,resource),null);
  await assert.rejects(()=>redeem(refresh(second.refresh_token)));
});
test('access expiry, absolute refresh expiry, and explicit revocation are enforced',async()=>{
  const first=await redeem((await grant()).params);
  await sql`UPDATE workflowy_oauth_grants SET access_expires=now()-interval '1 second' WHERE access_hash=${hash(first.access_token)}`;
  assert.equal(await verifyAccess(sql,owner,first.access_token,resource),null);
  const next=await redeem(refresh(first.refresh_token));
  await sql`UPDATE workflowy_oauth_grants SET refresh_expires=now()-interval '1 second' WHERE refresh_hash=${hash(next.refresh_token)}`;
  await assert.rejects(()=>redeem(refresh(next.refresh_token)));
  const last=await redeem((await grant()).params);
  await revokeToken(sql,owner,last.refresh_token,client);
  assert.equal(await verifyAccess(sql,owner,last.access_token,resource),null);
  await assert.rejects(()=>redeem(refresh(last.refresh_token)));
});
