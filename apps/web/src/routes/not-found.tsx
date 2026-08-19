import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main>
      <h1>Not found</h1>
      <p>
        That page does not exist. Try <Link to="/">the home page</Link> or{' '}
        <Link to="/search">search the ecosystem</Link>.
      </p>
    </main>
  );
}
