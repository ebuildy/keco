import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; there is no build step between them.
  transpilePackages: ['@keco/core', '@keco/query', '@keco/cache'],
  // @keco/core reads taxonomy.yaml from disk at module load. It is not an import, so the
  // bundler cannot see it — trace it explicitly or a standalone build throws on boot.
  outputFileTracingIncludes: {
    '/**': ['../../packages/core/taxonomy.yaml'],
  },
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
