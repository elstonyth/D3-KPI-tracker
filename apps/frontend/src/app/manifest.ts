import type { MetadataRoute } from 'next';
import { SITE_NAME } from '@gitroom/frontend/lib/site';

// Served at /manifest.webmanifest — makes the app installable (PWA).
// icon.png (1024²) doubles as the maskable icon — its glyph sits inside the
// safe zone on a dark bleed. Add a 192px variant only if an installer needs it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: 'D3',
    description:
      'Login-free social analytics — follower counts, views, and engagement across every platform.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0A0A0D',
    theme_color: '#0A0A0D',
    icons: [
      {
        src: '/icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
