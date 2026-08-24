import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="mx-auto max-w-[1200px] px-4 py-24 text-center">
      <h1 className="text-[25px] font-bold tracking-tight text-fg">Not found</h1>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
        That page does not exist. Try{' '}
        <Link to="/" className="text-accent-text">
          the home page
        </Link>{' '}
        or{' '}
        <Link to="/search" className="text-accent-text">
          search the ecosystem
        </Link>
        .
      </p>
    </main>
  );
}
