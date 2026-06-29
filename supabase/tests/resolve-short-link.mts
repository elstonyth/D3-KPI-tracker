/**
 * Unit test for resolveShortLink — no DB, no real network. A fake fetch returns
 * canned 30x/200 responses so redirect-following, the host allowlist, the cap,
 * and fail-closed behavior are all deterministic.
 *   pnpm exec tsx supabase/tests/resolve-short-link.mts
 */
import { resolveShortLink } from '@d3/database';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// Build a fake fetch from a map of url -> {status, location} (302) or {status:200}.
function fakeFetch(routes: Record<string, { status: number; location?: string }>) {
  return async (url: string | URL): Promise<Response> => {
    const key = url.toString();
    const r = routes[key];
    if (!r) throw new Error(`fakeFetch: no route for ${key}`);
    const headers = new Headers();
    if (r.location) headers.set('location', r.location);
    return new Response(null, { status: r.status, headers });
  };
}

async function main() {
  // 1. Non-shortlink host: returned unchanged, fetch never called.
  let called = false;
  const noFetch = (async () => { called = true; return new Response(null); }) as typeof fetch;
  const passthrough = await resolveShortLink('https://www.tiktok.com/@nasa', noFetch);
  check('non-shortlink passes through unchanged', passthrough === 'https://www.tiktok.com/@nasa');
  check('non-shortlink never hits the network', called === false);

  // 2. Single redirect to a canonical profile URL.
  const f1 = fakeFetch({
    'https://vm.tiktok.com/ZMabc/': { status: 302, location: 'https://www.tiktok.com/@nasa' },
    'https://www.tiktok.com/@nasa': { status: 200 },
  }) as typeof fetch;
  const r1 = await resolveShortLink('https://vm.tiktok.com/ZMabc/', f1);
  check('tiktok shortlink resolves to final url', r1 === 'https://www.tiktok.com/@nasa', r1);

  // 3. Bare (no-scheme) shortlink input still resolves.
  const f2 = fakeFetch({
    'https://v.douyin.com/abc/': { status: 301, location: 'https://www.douyin.com/user/MS4wABC' },
    'https://www.douyin.com/user/MS4wABC': { status: 200 },
  }) as typeof fetch;
  const r2 = await resolveShortLink('v.douyin.com/abc/', f2);
  check('bare douyin shortlink resolves', r2 === 'https://www.douyin.com/user/MS4wABC', r2);

  // 4. Self-loop → fail closed (return original).
  const loop = fakeFetch({
    'https://vm.tiktok.com/loop/': { status: 302, location: 'https://vm.tiktok.com/loop/' },
  }) as typeof fetch;
  const r3 = await resolveShortLink('https://vm.tiktok.com/loop/', loop);
  check('self-loop fails closed to original', r3 === 'https://vm.tiktok.com/loop/', r3);

  // 5. 5-hop cap: 6 distinct hops (h0→h1→h2→h3→h4→h5→h6) — cap exceeded → fail closed.
  const capFetch = fakeFetch({
    'https://vm.tiktok.com/h0/': { status: 302, location: 'https://vm.tiktok.com/h1/' },
    'https://vm.tiktok.com/h1/': { status: 302, location: 'https://vm.tiktok.com/h2/' },
    'https://vm.tiktok.com/h2/': { status: 302, location: 'https://vm.tiktok.com/h3/' },
    'https://vm.tiktok.com/h3/': { status: 302, location: 'https://vm.tiktok.com/h4/' },
    'https://vm.tiktok.com/h4/': { status: 302, location: 'https://vm.tiktok.com/h5/' },
    'https://vm.tiktok.com/h5/': { status: 302, location: 'https://vm.tiktok.com/h6/' },
  }) as typeof fetch;
  const r4cap = await resolveShortLink('https://vm.tiktok.com/h0/', capFetch);
  check('5-hop cap exceeded fails closed to original', r4cap === 'https://vm.tiktok.com/h0/', r4cap);

  // 6. Network error → fail closed (return original).
  const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
  const r4 = await resolveShortLink('https://vm.tiktok.com/x/', boom);
  check('network error fails closed to original', r4 === 'https://vm.tiktok.com/x/', r4);

  // SSRF: a redirect to an internal/metadata IP is blocked before fetch → fail closed.
  const ssrf = fakeFetch({
    'https://vm.tiktok.com/evil/': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
  }) as typeof fetch;
  const rSsrf = await resolveShortLink('https://vm.tiktok.com/evil/', ssrf);
  check('redirect to internal IP blocked (SSRF) → original', rSsrf === 'https://vm.tiktok.com/evil/', rSsrf);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
await main();
