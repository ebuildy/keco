import type { MetadataRoute } from 'next';
import { searchTools } from '@keco/query';
import { query } from '@/lib/query';

/** Generated from the index (§9). Deep paging is capped by pagination.maxTotalHits. */
export const revalidate = 86400;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const top = await searchTools(query, { sort: 'score', hitsPerPage: 1000 });

  return [
    { url: base, changeFrequency: 'daily', priority: 1 },
    ...top.hits.map((tool) => ({
      url: `${base}/tools/${tool.full_name}`,
      lastModified: tool.indexed_at,
      changeFrequency: 'weekly' as const,
    })),
  ];
}
