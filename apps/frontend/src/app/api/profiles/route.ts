/**
 * Disabled in Phase 3 (creator lockdown). Creator profile add/claim moved to
 * the agency admin; this endpoint returns 410 Gone. The profile/claim tables
 * and rows are untouched — only the creator-facing write path is closed.
 */
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ ok: false, error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
