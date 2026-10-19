import { metadata } from '../../../../lib/oauth/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() { return metadata(true); }
