import type { MetadataRoute } from 'next';
import { SITE_URL } from '@gitroom/frontend/lib/site';

// Served at /sitemap.xml. Static public routes only.
// ponytail: per-creator pages omitted — they'd need a DB read at build time.
// Add a dynamic block here if/when individual creator pages need indexing.
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    { path: '', priority: 1, changeFrequency: 'weekly' as const },
    { path: '/leaderboard', priority: 0.9, changeFrequency: 'daily' as const },
    { path: '/dashboard', priority: 0.9, changeFrequency: 'daily' as const },
    { path: '/about', priority: 0.6, changeFrequency: 'monthly' as const },
    { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' as const },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' as const },
  ];
  return routes.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  }));
}
