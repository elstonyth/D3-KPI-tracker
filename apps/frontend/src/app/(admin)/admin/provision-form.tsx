'use client';

/**
 * Admin "create creator" form. Credentials group + a dynamic list of social
 * profile URLs (add/remove rows). Submits to the createCreator server action
 * inside a transition; renders per-URL results + a once-only credentials panel.
 * On success the form clears so it's ready for the next creator.
 *
 * Yellow-mono: success/failure read from a glyph + label, not color.
 */

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { Button } from '@gitroom/frontend/components/ui/button';
import { Input } from '@gitroom/frontend/components/ui/input';
import { createCreator, type ProvisionResult } from './actions';

// Example URLs cycled across rows so the form reads as multi-platform, not
// Instagram-only. The actual platform is detected server-side from whatever is
// pasted (detectPlatform), so any supported host works regardless of which
// placeholder a given row shows. RedNote is archived/hidden, so it's omitted.
const URL_PLACEHOLDERS = [
  'https://www.instagram.com/handle',
  'https://www.tiktok.com/@handle',
  'https://www.facebook.com/handle',
  'https://www.douyin.com/user/MS4w...',
];

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-fg shrink-0">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-fgMuted shrink-0">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function ProvisionForm() {
  const rowSeq = useRef(1);
  const nextRowId = () => (rowSeq.current += 1);
  const [rows, setRows] = useState<{ id: number; value: string }[]>(() => [
    { id: 1, value: '' },
  ]);
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Submit via onSubmit (not the form `action` prop) so React does not
  // auto-reset the fields on a failed attempt. We reset explicitly, and only on
  // success: clear the inputs and collapse the URL list back to one empty row
  // so the filled-in values don't linger and eat space, leaving the form ready
  // for the next creator. The result panel still renders from `result`.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const res = await createCreator(null, formData);
      setResult(res);
      if (res.ok) {
        formRef.current?.reset();
        rowSeq.current = 1;
        setRows([{ id: 1, value: '' }]);
      }
    });
  }

  function updateRow(id: number, value: string) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, value } : row)));
  }
  function addRow() {
    setRows((r) => [...r, { id: nextRowId(), value: '' }]);
  }
  function removeRow(id: number) {
    setRows((r) => (r.length === 1 ? r : r.filter((row) => row.id !== id)));
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-5">
      {/* Credentials */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Display name</span>
          <Input name="display_name" type="text" required maxLength={80} placeholder="Creator name" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Email</span>
          <Input name="email" type="email" required maxLength={254} placeholder="creator@example.com" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Password</span>
          <Input name="password" type="password" required minLength={8} maxLength={72} placeholder="8 to 72 characters" />
        </label>
      </div>

      {/* Social URLs */}
      <div className="flex flex-col gap-2 border-t border-borderGlass pt-4">
        <span className="text-label text-fgMuted">Social profile URLs</span>
        <span className="text-caption text-fgSubtle">
          Instagram, TikTok, Facebook, or Douyin — the platform is detected
          automatically from the URL.
        </span>
        {rows.map((row, i) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              name="url"
              type="url"
              value={row.value}
              onChange={(e) => updateRow(row.id, e.target.value)}
              placeholder={URL_PLACEHOLDERS[i % URL_PLACEHOLDERS.length]}
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="shrink-0 size-9 inline-flex items-center justify-center rounded-md text-fgMuted hover:bg-white/[0.04] border border-white/10"
              aria-label="Remove URL"
            >
              <XGlyph />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="self-start text-label text-fgMuted hover:text-fg px-2 py-1"
        >
          + Add URL
        </button>
      </div>

      {/* Submit */}
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Creating…' : 'Create creator'}
        </Button>
      </div>

      {/* Error — still surfaces credentials on a partial failure (the auth user
          was created but a later step failed) so the admin doesn't lose the login. */}
      {result && !result.ok && (
        <div className="flex flex-col gap-3">
          <p className="text-caption text-fg flex items-center gap-1.5" role="alert">
            <XGlyph /> {result.message}
          </p>
          {result.credentials && (
            <CredentialsPanel email={result.credentials.email} password={result.credentials.password} />
          )}
        </div>
      )}

      {/* Success: credentials echo + per-URL results */}
      {result?.ok && (
        <div className="flex flex-col gap-4">
          <p className="text-caption text-fgMuted">{result.message}</p>
          {result.credentials && (
            <CredentialsPanel email={result.credentials.email} password={result.credentials.password} />
          )}
          {result.urlResults && result.urlResults.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {result.urlResults.map((r) => (
                <li key={r.url} className="flex items-center gap-2 text-caption min-w-0">
                  {r.status === 'failed' ? <XGlyph /> : <CheckGlyph />}
                  <span className="text-fgMuted truncate">
                    {r.platform ? `${r.platform} · ` : ''}
                    {r.url}
                  </span>
                  {r.detail && <span className="text-fgSubtle shrink-0">— {r.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

function CredentialsPanel({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (insecure context) or permission denied — the
      // credentials are visible on screen for manual copy, so just no-op.
      setCopied(false);
    }
  }
  return (
    <div className="glass-elevated rounded-xl border border-borderGlass p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-label text-fgMuted">Login credentials</span>
        <button type="button" onClick={copy} className="text-label text-aurora-cta hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="font-mono text-body-sm text-fg break-all">{email}</div>
      <div className="font-mono text-body-sm text-fg break-all">{password}</div>
      <span className="text-caption text-fgSubtle">
        Shown once — copy and share securely now.
      </span>
    </div>
  );
}
