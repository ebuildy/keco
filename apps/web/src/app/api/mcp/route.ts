import { NextResponse } from 'next/server';

/**
 * MCP endpoint (§11): streamable HTTP, Node runtime, read tools only.
 *
 * Two things decide whether Keco survives in an agent's toolset:
 *   - the tool *descriptions* are the interface. An agent picks from the description
 *     alone, so each one must say explicitly when NOT to use it.
 *   - responses stay compact. search_tools caps at 10 results with ~40-word summaries;
 *     a 50 KB response burns the caller's context and gets Keco dropped.
 *
 * Every item carries `url` (the Keco page) and `repo_url` so agents can cite, plus
 * `indexed_at` — eventual consistency must be visible to callers (§2.7).
 */
export const runtime = 'nodejs';

export const TOOLS = [
  {
    name: 'search_tools',
    description:
      'Search the Kubernetes ecosystem (CLIs, kubectl plugins, operators, Helm charts, dashboards) by natural-language need or by facet. Returns at most 10 tools ranked by relevance then health. Use when the user needs to find or choose a Kubernetes tool. Do NOT use for general Kubernetes how-to questions, for non-Kubernetes software, or to look up a tool you already know the repo of — use get_tool for that.',
  },
  {
    name: 'get_tool',
    description:
      'Full metadata for one tool by owner/repo: summary, kind, domains, health score breakdown, and install commands verified against real registry entries. Use when you already know which tool you mean. Do NOT use to discover tools — use search_tools.',
  },
  {
    name: 'compare_tools',
    description:
      'Compare 2-5 tools by owner/repo side by side on maintenance, install methods, license and adoption. Use when the user is choosing between named alternatives. Do NOT use to find candidates — use find_alternatives first.',
  },
  {
    name: 'find_alternatives',
    description:
      'Given one tool (owner/repo), return tools of the same kind solving overlapping problems, ranked by health. Use for "what else does what X does". Do NOT use for a free-text need — use search_tools.',
  },
  {
    name: 'whats_hot',
    description:
      'Highest-momentum projects, optionally within one domain. Momentum is stars per day of repo age damped by recent activity — it is NOT a 30-day star delta and must not be described as "trending this week". Use to surface fast-growing young projects.',
  },
] as const;

// TODO(mcp): serve the streamable HTTP transport and wire these five tools to
// @keco/query — the same functions the portal and REST use (§11).
export async function GET() {
  return NextResponse.json({ tools: TOOLS.map((tool) => tool.name), status: 'not_implemented' });
}

export async function POST() {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
