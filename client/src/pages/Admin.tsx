import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  createInvite,
  listInvites,
  listUsers,
  resetCredentials,
  revokeInvite,
  setUserRole,
  type Invite,
  type UserPage,
} from '../api/admin';
import type { User } from '../api/types';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { useAction } from '../hooks/useAction';

/**
 * /admin: invites, user roles and credential resets (docs/product/ui-ux-flows.md, Flow 10).
 * The server checks the admin role on every request; this page is only linked for admins.
 * Invite codes and temporary credentials are shown once, from the create/reset response.
 */
export function AdminPage() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <p className="page">Not found</p>;
  return (
    <main className="page">
      <header className="bar">
        <h1>Admin</h1>
        <Link to="/" className="button">
          Back to lobby
        </Link>
      </header>
      <InvitesSection />
      <UsersSection me={user} />
    </main>
  );
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

/** A secret the server returns once: shown until dismissed, with a copy button. */
function OneTimeSecret({ title, items, onDismiss }: { title: string; items: { label: string; value: string }[]; onDismiss(): void }) {
  return (
    <div className="secret" role="status">
      <p>
        <strong>{title}</strong> It is shown only once. Copy it now and share it with the person directly.
      </p>
      {items.map((item) => (
        <CopyValue key={item.label} {...item} />
      ))}
      <button type="button" onClick={onDismiss}>
        Done
      </button>
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard access (e.g. plain http): the value is selectable, so copying by hand works.
      setCopied(false);
    }
  };
  return (
    <div className="copy-value">
      <span className="muted">{label}</span>
      <code>{value}</code>
      <button type="button" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {copied === false && <span className="hint">Could not copy. Select the text and copy it instead.</span>}
    </div>
  );
}

// --- Invites -------------------------------------------------------------------------------

function InvitesSection() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ code: string; label: string | null } | null>(null);
  const load = useAction();
  const create = useAction();
  const revoke = useAction();

  const refresh = useCallback(() => load.run(async () => setInvites(await listInvites())), [load.run]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      const result = await createInvite(label.trim());
      setCreated({ code: result.code, label: result.invite.label });
      setLabel('');
      setInvites((list) => [result.invite, ...(list ?? [])]);
    });
  };

  const onRevoke = (invite: Invite) => {
    const name = invite.label ? `the invite for ${invite.label}` : 'this invite';
    if (!window.confirm(`Revoke ${name}? The code will stop working.`)) return;
    void revoke.run(async () => {
      await revokeInvite(invite.id);
      await refresh();
    });
  };

  return (
    <section>
      <h2>Invites</h2>
      <form onSubmit={onCreate} className="stack" noValidate>
        <Field
          label="Recipient (optional)"
          value={label}
          onChange={setLabel}
          hint="A note to help you remember who the code is for."
          maxLength={128}
          autoComplete="off"
        />
        <ErrorText error={create.error} />
        <button type="submit" className="primary" disabled={create.busy}>
          {create.busy ? 'Generating…' : 'Generate invite code'}
        </button>
      </form>
      {created && (
        <OneTimeSecret
          title={created.label ? `Invite code for ${created.label}.` : 'Invite code.'}
          items={[{ label: 'Invite code', value: created.code }]}
          onDismiss={() => setCreated(null)}
        />
      )}

      <ErrorText error={load.error ?? revoke.error} />
      {invites === null ? (
        <p className="muted">Loading invites…</p>
      ) : invites.length === 0 ? (
        <p className="muted">No invites yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Status</th>
              <th scope="col">Created</th>
              <th scope="col">Expires</th>
              <th scope="col">Used by</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id}>
                <td data-label="Label">{invite.label ?? <span className="muted">No label</span>}</td>
                <td data-label="Status">
                  <span className={`badge ${invite.status}`}>{invite.status}</span>
                </td>
                <td data-label="Created">{formatDate(invite.createdAt)}</td>
                <td data-label="Expires">{formatDate(invite.expiresAt)}</td>
                <td data-label="Used by">{invite.redeemedByUsername ?? '—'}</td>
                <td className="row-actions">
                  {invite.status === 'pending' && (
                    <button type="button" className="danger" disabled={revoke.busy} onClick={() => onRevoke(invite)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- Users ---------------------------------------------------------------------------------

const PAGE_SIZE = 50;

function UsersSection({ me }: { me: User }) {
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<UserPage | null>(null);
  const [filter, setFilter] = useState('');
  const [reset, setReset] = useState<{ user: User; password: string; passphrase: string } | null>(null);
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void load.run(async () => setUsers(await listUsers(page, PAGE_SIZE)));
  }, [load.run, page]);

  const replace = (updated: User) =>
    setUsers((p) => (p ? { ...p, data: p.data.map((u) => (u.id === updated.id ? updated : u)) } : p));

  const changeRole = (target: User, role: User['role']) => {
    const question =
      role === 'admin'
        ? `Make ${target.displayName} (${target.username}) an admin? They will be able to manage invites, roles and accounts.`
        : `Remove admin from ${target.displayName} (${target.username})?`;
    if (!window.confirm(question)) return;
    void act.run(async () => replace(await setUserRole(target.id, role)));
  };

  const resetUser = (target: User) => {
    if (
      !window.confirm(
        `Reset the password and recovery passphrase for ${target.displayName} (${target.username})? ` +
          'They will be signed out everywhere and must choose new ones when they next sign in.',
      )
    )
      return;
    void act.run(async () => {
      const creds = await resetCredentials(target.id);
      setReset({ user: target, password: creds.temporaryPassword, passphrase: creds.temporaryPassphrase });
      replace({ ...target, requiresCredentialChange: true });
    });
  };

  const needle = filter.trim().toLowerCase();
  const shown = (users?.data ?? []).filter(
    (u) => !needle || u.username.includes(needle) || u.displayName.toLowerCase().includes(needle),
  );
  const pages = users ? Math.max(1, Math.ceil(users.total / users.limit)) : 1;

  return (
    <section>
      <h2>Users</h2>
      {reset && (
        <OneTimeSecret
          title={`Temporary credentials for ${reset.user.displayName} (${reset.user.username}).`}
          items={[
            { label: 'Temporary password', value: reset.password },
            { label: 'Temporary recovery passphrase', value: reset.passphrase },
          ]}
          onDismiss={() => setReset(null)}
        />
      )}
      <Field label="Find a user" value={filter} onChange={setFilter} type="search" autoComplete="off" hint="Filters this page by username or display name." />
      <ErrorText error={load.error ?? act.error} />
      {users === null ? (
        <p className="muted">Loading users…</p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id}>
                    <td data-label="User">
                      <strong>{u.displayName}</strong> <span className="muted">{u.username}</span>
                      {self && <span className="muted"> (you)</span>}
                      {u.requiresCredentialChange && <div className="hint">Must change credentials at next sign-in</div>}
                    </td>
                    <td data-label="Role">
                      <span className={`badge ${u.role}`}>{u.role}</span>
                    </td>
                    <td data-label="Joined">{formatDate(u.createdAt)}</td>
                    <td className="row-actions">
                      {u.role === 'player' ? (
                        <button type="button" disabled={act.busy} onClick={() => changeRole(u, 'admin')}>
                          Make admin
                        </button>
                      ) : (
                        // Admins cannot remove their own role (lockout prevention); the server refuses it too.
                        !self && (
                          <button type="button" disabled={act.busy} onClick={() => changeRole(u, 'player')}>
                            Remove admin
                          </button>
                        )
                      )}
                      {/* Your own credentials are changed from the profile page. */}
                      {!self && (
                        <button type="button" className="danger" disabled={act.busy} onClick={() => resetUser(u)}>
                          Reset credentials
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted">No matching users on this page.</p>}
          {pages > 1 && (
            <nav className="actions spaced" aria-label="User pages">
              <button type="button" disabled={page <= 1 || load.busy} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted pager">
                Page {page} of {pages}
              </span>
              <button type="button" disabled={page >= pages || load.busy} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
