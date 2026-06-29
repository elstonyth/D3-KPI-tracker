'use client';

/**
 * Per-creator editor. Each section posts to its own server action via
 * useActionState; rows live in their own components so hooks obey
 * react-hooks/rules-of-hooks. Password reset reveals the new password once,
 * reusing the provision-form credentials pattern.
 */

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Input } from '@gitroom/frontend/components/ui/input';
import { Button } from '@gitroom/frontend/components/ui/button';
import type { AdminCreatorDetail, AdminProfileRow, AdminCreatorLogin } from '@gitroom/frontend/lib/admin-creators';
import {
  renameCreator,
  addCreatorUrl,
  editCreatorUrl,
  removeCreatorUrl,
  addCreatorLogin,
  resetCreatorPassword,
  deleteCreator,
  type ActionResult,
  type PasswordResetResult,
} from './actions';

const SECTION = 'glass-subtle border border-borderGlass rounded-2xl p-6 flex flex-col gap-4';
const ERR = 'text-caption text-red-400';
const OK = 'text-caption text-fgMuted';

function Save({ label = 'Save' }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <span className={state.ok ? OK : ERR}>{state.message}</span>;
}

export function CreatorEditor({ detail }: { detail: AdminCreatorDetail }) {
  return (
    <div className="flex flex-col gap-8">
      <RenameSection creatorId={detail.creatorId} displayName={detail.displayName} />
      <UrlsSection creatorId={detail.creatorId} profiles={detail.profiles} />
      <LoginsSection creatorId={detail.creatorId} logins={detail.logins} />
      <DangerSection creatorId={detail.creatorId} displayName={detail.displayName} />
    </div>
  );
}

function RenameSection({ creatorId, displayName }: { creatorId: string; displayName: string }) {
  const [state, action] = useActionState(renameCreator, null);
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Display name</h2>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <Input name="display_name" type="text" required maxLength={80} defaultValue={displayName} className="flex-1" />
        <Save />
      </form>
      <Msg state={state} />
    </section>
  );
}

function UrlsSection({ creatorId, profiles }: { creatorId: string; profiles: AdminProfileRow[] }) {
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Social URLs</h2>
      {profiles.length === 0 ? (
        <p className="text-body text-fgMuted">No profiles yet — add one below.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.map((p) => (
            <ProfileUrlRow key={p.id} creatorId={creatorId} profile={p} />
          ))}
        </ul>
      )}
      <AddUrlRow creatorId={creatorId} />
    </section>
  );
}

function ProfileUrlRow({ creatorId, profile }: { creatorId: string; profile: AdminProfileRow }) {
  const [editState, editAction] = useActionState(editCreatorUrl, null);
  const [removeState, removeAction] = useActionState(removeCreatorUrl, null);
  const [confirming, setConfirming] = useState(false);
  const editFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (editState?.ok) editFormRef.current?.reset();
  }, [editState]);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-caption text-fgSubtle w-16 shrink-0">{profile.platform}</span>
        <form ref={editFormRef} action={editAction} className="flex items-center gap-2 flex-1">
          <input type="hidden" name="creator_id" value={creatorId} />
          <input type="hidden" name="profile_id" value={profile.id} />
          <Input name="url" type="url" defaultValue={profile.profileUrl} className="flex-1" />
          <Save />
        </form>
        {confirming ? (
          <form action={removeAction} className="flex items-center gap-2">
            <input type="hidden" name="creator_id" value={creatorId} />
            <input type="hidden" name="profile_id" value={profile.id} />
            <span className="text-caption text-fgMuted">Remove?</span>
            <Save label="Confirm" />
            <button type="button" onClick={() => setConfirming(false)} className="text-caption text-fgSubtle hover:text-fg">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-caption text-fgMuted hover:text-fg border border-white/10 rounded-md px-2 py-1"
          >
            Remove
          </button>
        )}
      </div>
      <Msg state={editState} />
      <Msg state={removeState} />
    </li>
  );
}

function AddUrlRow({ creatorId }: { creatorId: string }) {
  const [state, action] = useActionState(addCreatorUrl, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  return (
    <div className="flex flex-col gap-1.5 border-t border-borderGlass pt-4">
      <span className="text-label text-fgMuted">Add a URL</span>
      <form ref={formRef} action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <Input name="url" type="url" required placeholder="https://www.instagram.com/handle" className="flex-1" />
        <Save label="Add" />
      </form>
      <Msg state={state} />
    </div>
  );
}

function LoginsSection({ creatorId, logins }: { creatorId: string; logins: AdminCreatorLogin[] }) {
  // Own the add-login action state HERE, not inside AddLoginRow: a successful add
  // revalidates → logins becomes nonzero → the add-form unmounts. Holding the
  // state in this always-mounted section preserves the one-time credentials
  // across that swap, and surfaces them on partial failure too (login created
  // but a downstream step failed), where the generated password is irreplaceable.
  const [addState, addAction] = useActionState(addCreatorLogin, null as PasswordResetResult | null);
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Login &amp; password</h2>
      {logins.length === 0 ? (
        <AddLoginRow creatorId={creatorId} state={addState} action={addAction} />
      ) : (
        <ul className="flex flex-col gap-4">
          {logins.map((l) => (
            <LoginRow key={l.userId} creatorId={creatorId} login={l} />
          ))}
        </ul>
      )}
      {addState?.credentials && (
        <CredentialsPanel email={addState.credentials.email} password={addState.credentials.password} />
      )}
    </section>
  );
}

function AddLoginRow({
  creatorId,
  state,
  action,
}: {
  creatorId: string;
  state: PasswordResetResult | null;
  action: (formData: FormData) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body text-fgMuted">No login linked — create one to give this creator portal access.</p>
      <form ref={formRef} action={action} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="creator_id" value={creatorId} />
        <Input name="email" type="email" required placeholder="creator@email.com" className="flex-1" />
        {/* type="text" is intentional — admin sees/copies the password to share it once */}
        <Input name="password" type="text" placeholder="Password (blank = generate)" minLength={8} maxLength={72} className="flex-1" />
        <Save label="Create login" />
      </form>
      {/* CredentialsPanel is rendered by LoginsSection so it survives the form's
          unmount on success; here we only show the inline error on failure. */}
      {state && !state.ok && <span className={ERR}>{state.message}</span>}
    </div>
  );
}

function LoginRow({ creatorId, login }: { creatorId: string; login: AdminCreatorLogin }) {
  const [state, action] = useActionState(resetCreatorPassword, null as PasswordResetResult | null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  return (
    <li className="flex flex-col gap-2">
      <div className="text-body text-fg">{login.email}</div>
      <form ref={formRef} action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <input type="hidden" name="user_id" value={login.userId} />
        {/* type="text" is intentional — admin sees/copies the new password to share it once */}
        <Input name="password" type="text" placeholder="New password (blank = generate)" minLength={8} maxLength={72} className="flex-1" />
        <Save label="Reset password" />
      </form>
      {state && !state.ok && <span className={ERR}>{state.message}</span>}
      {state?.ok && state.credentials && (
        <CredentialsPanel email={state.credentials.email} password={state.credentials.password} />
      )}
    </li>
  );
}

function CredentialsPanel({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="glass-elevated rounded-xl border border-borderGlass p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-label text-fgMuted">New credentials</span>
        <button type="button" onClick={copy} className="text-label text-aurora-cta hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="font-mono text-body-sm text-fg break-all">{email}</div>
      <div className="font-mono text-body-sm text-fg break-all">{password}</div>
      <span className="text-caption text-fgSubtle">Shown once — copy and share securely now.</span>
    </div>
  );
}

function DangerSection({ creatorId, displayName }: { creatorId: string; displayName: string }) {
  const [state, action] = useActionState(deleteCreator, null);
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Danger zone</h2>
      <p className="text-body text-fgMuted">
        Deletes <span className="text-fg">{displayName}</span>, all its profiles and stats, and its login. Cannot be undone.
      </p>
      {confirming ? (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="creator_id" value={creatorId} />
          <span className="text-caption text-fgMuted">Delete this creator and login?</span>
          <Save label="Delete creator" />
          <button type="button" onClick={() => setConfirming(false)} className="text-caption text-fgSubtle hover:text-fg">
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start text-label text-fgMuted hover:text-fg border border-white/10 rounded-md px-3 py-1.5"
        >
          Delete creator
        </button>
      )}
      {state && !state.ok && <span className={ERR}>{state.message}</span>}
    </section>
  );
}
