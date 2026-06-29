/**
 * UUID-format guard for ids arriving from route params / FormData before they
 * hit a Postgres `uuid` column. Passing a non-UUID to `.eq('id', x)` on a uuid
 * column raises `invalid input syntax for type uuid`, which today surfaces as a
 * raw 500 / error.message. Pre-checking turns that into a clean 400 and stops
 * the DB internals from leaking. Shape-only (any hex layout) — bounds length and
 * blocks garbage; the column itself remains the authority on real existence.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
