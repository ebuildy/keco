/**
 * Deliberately fetches nothing.
 *
 * `renderToString` does not run effects, so a footer that queried Meilisearch would ship empty
 * into all 1000 prerendered tool pages and only fill in after hydration. Corpus size and
 * freshness live where a query already happens — the home page and the tool page — rather than
 * costing every page a request to say the same thing.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-6 text-xs leading-relaxed text-muted">
        <p>
          Keco classifies and ranks the Kubernetes ecosystem from public GitHub data. Everything
          here is derived — there is no curation and no editorial content.
        </p>
        <p className="mt-1 text-faint">
          Scores are computed from repository metadata and public signals. Install commands are
          listed only where they are verified against a registry.
        </p>
      </div>
    </footer>
  );
}
