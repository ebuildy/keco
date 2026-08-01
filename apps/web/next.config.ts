import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; there is no build step between them.
  transpilePackages: ['@keco/core', '@keco/query', '@keco/cache'],
  // README images are rewritten against the repo's image_base_url and come from GitHub (§9).
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'raw.githubusercontent.com' },
      { protocol: 'https', hostname: 'github.com' },
      { protocol: 'https', hostname: 'img.shields.io' },
    ],
  },
};

export default nextConfig;
