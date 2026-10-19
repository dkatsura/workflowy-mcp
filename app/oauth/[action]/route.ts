import { NextRequest } from 'next/server';
import { handle } from '../../lib/oauth/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function route(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  return handle(request,(await context.params).action);
}
export { route as GET, route as POST };
export async function OPTIONS() {
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'}});
}
