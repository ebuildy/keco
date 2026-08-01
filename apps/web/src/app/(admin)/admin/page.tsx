/**
 * Backoffice (§10): observe and command, never edit.
 *
 * If you find yourself adding an "edit this field" form, stop — the fix belongs in the
 * analyzer's rules, where it improves every repo instead of one.
 */
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <main>
      <h1>Pipeline</h1>
      {/* TODO(admin): read repos_state — counts by phase, failures, skip reasons,
          confidence distribution, GitHub quota remaining, and checkpoint lag per consumer
          (the number that says whether the system is keeping up). */}
      <p>Pipeline health is not wired up yet — see AGENTS.md §10.</p>

      <h2>Commands</h2>
      {/* Commands enqueue an event or reset a checkpoint and return immediately. They
          never do the work in the request — long work cannot run in a route handler (§14). */}
      <ul>
        <li>Re-crawl a repo</li>
        <li>Re-analyze a repo</li>
        <li>Re-analyze everything with confidence &lt; 0.7</li>
        <li>Rebuild the index</li>
        <li>Promote / rollback an alias</li>
      </ul>
    </main>
  );
}
