const assert = require('node:assert/strict');
const {test,after,before}=require('node:test');
const {createHash,randomBytes}=require('node:crypto');
const {NextRequest}=require('next/server');
const {PGlite}=require('@electric-sql/pglite');
const db=new PGlite();
const base='https://mcp.example';
process.env.OAUTH_ISSUER=base;
process.env.ADMIN_SECRET='test-only-admin';
process.env.MCP_ACCESS_SECRET='test-only-mcp';
process.env.WORKFLOWY_API_KEY='test-only-workflowy';
process.env.DATABASE_URL='postgresql://test:test@unit-test.neon.tech/db';
// Run the production Neon SQL in isolated Postgres. No external network or real credentials.
const neonFetch=async(url,init)=>{
  assert.equal(new URL(url).hostname,'api.neon.tech');
  const {query,params}=JSON.parse(init.body);
  try {
    const result=await db.query(query,params);
    const fields=result.fields;
    const rows=result.rows.map(row=>fields.map(field=>{
      const value=row[field.name];
      if(value===null || value===undefined)return null;
      if(value instanceof Date)return value.toISOString();
      if(typeof value==='boolean')return value?'t':'f';
      if(typeof value==='object')return JSON.stringify(value);
      return String(value);
    }));
    return Response.json({fields,rows,rowCount:result.affectedRows||rows.length,command:query.trim().split(' ')[0]});
  }catch(error){return Response.json({message:error.message},{status:400});}
};
const route=require('../.next/server/app/oauth/[action]/route.js').routeModule.userland;
const login=require('../.next/server/app/api/admin/login/route.js').routeModule.userland;
const mcp=require('../.next/server/app/api/[transport]/route.js').routeModule.userland;
const meta=require('../.next/server/app/.well-known/oauth-authorization-server/route.js').routeModule.userland;
const resourceMeta=require('../.next/server/app/.well-known/oauth-protected-resource/route.js').routeModule.userland;
const callback='https://chatgpt.com/connector_platform_oauth_redirect';
function request(action,method='GET',body,headers={}){
  return new NextRequest(base+'/oauth/'+action,{method,headers,...(body!==undefined?{body}:{} )});
}
const call=(action,req)=>route[req.method](req,{params:Promise.resolve({action})});
const form=(action,body,headers={})=>call(action,request(action,'POST',new URLSearchParams(body).toString(),{'Content-Type':'application/x-www-form-urlencoded',...headers}));
let client;
async function consent(cookie='') {
  if(!client){const r=await call('register',request('register','POST',JSON.stringify({redirect_uris:[callback],token_endpoint_auth_method:'none'}),{'Content-Type':'application/json'}));assert.equal(r.status,201);client=(await r.json()).client_id;}
  const verifier=randomBytes(32).toString('base64url');
  const query=new URLSearchParams({client_id:client,redirect_uri:callback,response_type:'code',resource:base+'/api/mcp',scope:'workflowy offline_access',state:'echo-this',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const response=await call('authorize',new NextRequest(base+'/oauth/authorize?'+query,{headers:{Cookie:cookie}}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'),'strict-origin');
  const html=await response.text();
  const proof=html.match(/name="proof" value="([^"]+)"/)[1];
  const cookies=[cookie,response.headers.get('set-cookie').split(';')[0]].filter(Boolean).join('; ');
  return {proof,cookies,verifier,html};
}
before(async()=>{ await db.waitReady; global.fetch=neonFetch; });
after(async()=>db.close());
test('discovery advertises a consistent issuer, resource, S256 and public DCR',async()=>{
  const m=await meta.GET().json(), r=await resourceMeta.GET().json();
  assert.equal(m.issuer,base);assert.deepEqual(r.authorization_servers,[base]);assert.equal(r.resource,base+'/api/mcp');
  assert.deepEqual(m.code_challenge_methods_supported,['S256']);
  assert.deepEqual(m.token_endpoint_auth_methods_supported,['none']);
});
test('consent requires a signed browser-bound proof and same-origin POST; no GET grants',async()=>{
  const c=await consent();assert.match(c.html,/name="secret"/);
  assert.equal((await form('authorize',{proof:c.proof,decision:'allow'},{Origin:base})).status,403);
  assert.equal((await form('authorize',{proof:c.proof,decision:'allow'},{Origin:'https://evil.example',Cookie:c.cookies})).status,403);
  assert.equal((await form('authorize',{proof:c.proof,decision:'allow'},{Origin:'null',Cookie:c.cookies})).status,403);
  assert.equal((await form('authorize',{proof:c.proof+'x',decision:'allow'},{Origin:base,Cookie:c.cookies})).status,400);
  assert.equal((await form('authorize',{proof:c.proof,decision:'allow',secret:'wrong'},{Origin:base,Cookie:c.cookies})).status,401);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM workflowy_oauth_grants')).rows[0].n,0);
});
test('denial returns state and issuer without creating a grant',async()=>{
  const c=await consent();const r=await form('authorize',{proof:c.proof,decision:'deny'},{Origin:base,Cookie:c.cookies});
  assert.equal(r.status,303);const location=new URL(r.headers.get('location'));
  assert.equal(location.origin,'https://chatgpt.com');assert.equal(location.searchParams.get('error'),'access_denied');
  assert.equal(location.searchParams.get('state'),'echo-this');assert.equal(location.searchParams.get('iss'),base);
});
test('production HTTP handlers: admin consent, code exchange, MCP, refresh and revocation',async()=>{
  const l=await login.POST(new NextRequest(base+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:'test-only-admin'})}));
  const c=await consent(l.headers.get('set-cookie').split(';')[0]);
  assert.doesNotMatch(c.html,/name="secret"/);
  const approve=await form('authorize',{proof:c.proof,decision:'allow'},{Origin:base,Cookie:c.cookies});
  assert.equal(approve.status,303);
  const loc=new URL(approve.headers.get('location'));assert.equal(loc.searchParams.get('iss'),base);
  const t=await form('token',{client_id:client,redirect_uri:callback,resource:base+'/api/mcp',grant_type:'authorization_code',code:loc.searchParams.get('code'),code_verifier:c.verifier});
  assert.equal(t.status,200);assert.equal(t.headers.get('cache-control'),'no-store');const tokens=await t.json();
  const rpc=token=>mcp.POST(new NextRequest(base+'/api/mcp',{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})}),{params:Promise.resolve({transport:'mcp'})});
  const response=await rpc(tokens.access_token);assert.equal(response.status,200);assert.match(await response.text(),/search_nodes/);
  const updated=await form('token',{client_id:client,resource:base+'/api/mcp',grant_type:'refresh_token',refresh_token:tokens.refresh_token});
  assert.equal(updated.status,200);const next=await updated.json();assert.equal((await rpc(tokens.access_token)).status,401);
  assert.equal((await rpc(next.access_token)).status,200);
  const revoked=await form('revoke',{client_id:client,token:next.refresh_token});assert.equal(revoked.status,200);
  assert.equal((await rpc(next.access_token)).status,401);
});
test('untrusted host and oversized registration are rejected',async()=>{
  assert.equal((await call('register',new NextRequest('https://evil.example/oauth/register',{method:'POST',body:'{}'}))).status,400);
  assert.equal((await call('register',request('register','POST','x'.repeat(20001),{'Content-Type':'application/json'}))).status,413);
});
