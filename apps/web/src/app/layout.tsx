import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: {
    default: 'Keco — the Kubernetes ecosystem search engine',
    template: '%s · Keco',
  },
  description:
    'Search the Kubernetes ecosystem: CLIs, kubectl plugins, operators, Helm charts and dashboards, classified and ranked by health rather than stars.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
