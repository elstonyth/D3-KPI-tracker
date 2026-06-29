/**
 * Disabled in Phase 3 (creator lockdown). Auto-discovery claim acceptance is no
 * longer creator-facing; returns 410 Gone. Tables/rows untouched.
 */
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ ok: false, error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
