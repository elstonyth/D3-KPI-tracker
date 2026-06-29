import { Geist, Geist_Mono } from 'next/font/google';

// Self-hosted via next/font (build-time download → served from our origin).
// Replaces the render-blocking Google Fonts @import in global.scss; the CSS
// variables are wired into Tailwind's fontFamily.{sans,mono}.
export const geistSans = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-sans',
});

export const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-mono',
});
