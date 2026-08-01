import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { findAlternatives, getTool } from '@keco/query';
import { query } from '@/lib/query';
import { readReadme } from '@/lib/readme';

/**
 * Tool page — the SEO surface (§9). RSC + ISR; must work with JavaScript disabled.
 *
 * The README is read from the *cache*, by key, not from the index. That is the one place
 * the read side touches write-side storage — a read of an immutable blob. Never write,
 * never list.
 */
export const revalidate = 3600;

type Params = Promise<{ owner: string; repo: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo } = await params;
  const tool = await getTool(query, `${owner}/${repo}`);
  if (!tool) return {};
  return {
    title: tool.full_name,
    description: tool.summary,
    alternates: { canonical: `/tools/${tool.full_name}` },
  };
}

// TODO(portal): generateStaticParams for the top 1000 by score (§9).

export default async function ToolPage({ params }: { params: Params }) {
  const { owner, repo } = await params;
  const fullName = `${owner}/${repo}`;
  const tool = await getTool(query, fullName);
  if (!tool) notFound();

  const [readme, related] = await Promise.all([
    readReadme(fullName),
    findAlternatives(query, fullName, 6),
  ]);

  return (
    <main>
      <h1>{tool.full_name}</h1>
      <p>{tool.summary}</p>

      <section>
        <h2>Install</h2>
        {tool.install_methods.length === 0 ? (
          // Unprovable ⇒ not listed. A wrong `brew install` line is the worst bug we can
          // ship — people paste these into a terminal (§6).
          <p>No install method verified against a registry.</p>
        ) : (
          <ul>
            {tool.install_methods.map((method) => (
              <li key={method.method}>
                <code>{method.command}</code>{' '}
                <a href={method.source_url} rel="noreferrer">
                  proof
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Health</h2>
        <dl>
          <dt>Score</dt>
          <dd>{tool.score.total.toFixed(2)}</dd>
          <dt>Quality coverage</dt>
          {/* 0.9 backed by four signals and 0.9 backed by one are not the same claim (§4.3). */}
          <dd>{Math.round(tool.score.quality_coverage * 100)}% of signals present</dd>
          <dt>Momentum</dt>
          <dd>{tool.score.momentum.toFixed(2)}</dd>
        </dl>
      </section>

      <aside>
        <ul>
          <li>★ {tool.stars}</li>
          <li>{tool.language ?? 'unknown language'}</li>
          <li>{tool.license ?? 'no license'}</li>
          <li>Last commit {new Date(tool.pushed_at).toDateString()}</li>
          <li>
            <a href={tool.repo_url} rel="noreferrer">
              Source on GitHub
            </a>
          </li>
        </ul>
      </aside>

      {/* TODO(portal): sanitise (rehype-sanitize), rewrite relative URLs against
          image_base_url, strip the badge-only paragraph, highlight with Shiki (§9). */}
      <section>
        <h2>README</h2>
        {readme === null ? <p>README not cached yet.</p> : <pre>{readme.slice(0, 4000)}</pre>}
      </section>

      <section>
        <h2>Related</h2>
        <ul>
          {related.map((other) => (
            <li key={other.id}>
              <Link href={`/tools/${other.full_name}`}>{other.full_name}</Link>
            </li>
          ))}
        </ul>
      </section>

      <footer>
        Data from GitHub, updated {new Date(tool.indexed_at).toISOString()}.
      </footer>
    </main>
  );
}
