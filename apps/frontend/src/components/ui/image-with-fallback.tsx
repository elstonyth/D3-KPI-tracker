'use client';

import { useState, type ReactNode } from 'react';

interface ImageWithFallbackProps {
  /** Image source. When null/undefined the fallback renders immediately. */
  src: string | null | undefined;
  alt: string;
  className?: string;
  /**
   * Rendered when `src` is absent OR the image fails to load (e.g. an expired
   * signed CDN URL that makes /api/proxy-image return 502).
   */
  fallback: ReactNode;
  loading?: 'lazy' | 'eager';
}

/**
 * <img> that degrades to a fallback node on load failure, not just on a null
 * src. Avatars/thumbnails are signed CDN URLs proxied via /api/proxy-image; when
 * a signature expires the proxy 502s and a bare <img> shows the browser's
 * broken-image glyph. Rendering the fallback on `onError` avoids that.
 *
 * Tracking the failed src (rather than a boolean) resets the error state when
 * the src changes, so a reused list slot retries the new image.
 */
export function ImageWithFallback({
  src,
  alt,
  className,
  fallback,
  loading = 'lazy',
}: ImageWithFallbackProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external/proxied image, dims vary by platform
    <img
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      className={className}
      onError={() => setFailedSrc(src)}
    />
  );
}
