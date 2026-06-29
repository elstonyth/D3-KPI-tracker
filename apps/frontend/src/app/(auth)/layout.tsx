import '../global.scss';
import { geistSans, geistMono } from '../fonts';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  title: 'Sign in — D3 Creator',
};

// Auth pages read cookies (getAuthContext) and must never prerender at build
// time — Supabase env is required at construction and Next.js otherwise tries
// to statically render /onboarding and friends.
export const dynamic = 'force-dynamic';

// Auth route group has its own html/body so the AuthShell can take the full
// viewport without inheriting (public)'s header/footer chrome.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <head>
        <link rel="icon" href="/d3-logo.png?v=3" type="image/png" />
        <meta name="darkreader-lock" />
      </head>
      <body className="dark bg-canvas text-fg font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
