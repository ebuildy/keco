import { NextResponse } from 'next/server';
import { getTool } from '@keco/query';
import { query } from '@/lib/query';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  const { owner, repo } = await params;
  const tool = await getTool(query, `${owner}/${repo}`);

  if (!tool) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(tool, {
    headers: { 'access-control-allow-origin': '*' },
  });
}
