import type { MetadataRoute } from 'next';
import { SITE_URL } from '@gitroom/frontend/lib/site';

// Served at /robots.txt. Public marketing/leaderboard pages are crawlable;
// authed dashboards, auth flow, and API routes are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/me', '/api', '/auth', '/login'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
