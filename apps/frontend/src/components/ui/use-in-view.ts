'use client';

import { useEffect, useRef, useState } from 'react';

interface UseInViewOptions {
  /** IntersectionObserver rootMargin (default expands viewport upward, triggers slightly before fully visible) */
  rootMargin?: string;
  /** Trigger threshold (0-1) */
  threshold?: number;
  /** Fire once and disconnect (default true) */
  once?: boolean;
}

interface UseInViewResult<T extends Element> {
  ref: React.MutableRefObject<T | null>;
  inView: boolean;
}

export function useInView<T extends Element = HTMLElement>(
  options: UseInViewOptions = {}
): UseInViewResult<T> {
  const { rootMargin = '0px 0px -10% 0px', threshold = 0.15, once = true } = options;
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // IntersectionObserver is universally supported; the old no-IO fallback
    // called setState synchronously in the effect (react-hooks/set-state-in-effect)
    // and only ran in environments that don't exist on the client.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { rootMargin, threshold }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, threshold, once]);

  return { ref, inView };
}
