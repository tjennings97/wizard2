import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  BUG_RESOLUTION_LABELS,
  createInvite,
  listBugReports,
  listInvites,
  listUsers,
  resetCredentials,
  revokeInvite,
  setBugResolution,
  setUserRole,
  type AdminBugReport,
  type BugReportPage,
  type BugResolution,
  type BugSeverity,
  type BugStatus,
  type Invite,
  type InviteStatus,
  type AdminUser,
  type UserPage,
} from '../api/admin';
import type { User } from '../api/types';
import { Field } from '../components/Field';
import { useAuth } from '../context/AuthContext';
import { useAction } from '../hooks/useAction';

/**
 * /admin: invites, user roles, credential resets (docs/product/ui-ux-flows.md, Flow 10) and the
 * bug reports users have sent, which admins dismiss once handled.
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
      <BugReportsSection />
    </main>
  );
}

/**
 * Loads `fetch` whenever `deps` change (or on retry). A response that arrives after a newer load
 * started is dropped, error included, so the list always matches the current page and filter.
 */
function useLatestLoad<T>(fetch: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [attempt, setAttempt] = useState(0);
  const load = useAction();
  useEffect(() => {
    let current = true;
    void load.run(async () => {
      try {
        const result = await fetch();
        if (current) setData(result);
      } catch (err) {
        if (current) throw err;
      }
    });
    return () => {
      current = false;
    };
  }, [load.run, attempt, ...deps]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, setData, busy: load.busy, error: load.error, retry };
}

/** Shown until the first load succeeds: the loading text, or the error with a Retry button. */
function FirstLoad({ what, error, busy, retry }: { what: string; error: string | null; busy: boolean; retry(): void }) {
  if (!error) return <p className="muted">Loading {what}…</p>;
  return (
    <p className="actions">
      <button type="button" onClick={retry} disabled={busy}>
        Retry
      </button>
    </p>
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

const INVITE_FILTERS: { value: InviteStatus | ''; label: string; empty: string }[] = [
  { value: 'pending', label: 'Pending', empty: 'No pending invites.' },
  { value: 'accepted', label: 'Accepted', empty: 'No accepted invites.' },
  { value: 'expired', label: 'Expired', empty: 'No expired invites.' },
  { value: 'revoked', label: 'Revoked', empty: 'No revoked invites.' },
  { value: '', label: 'All', empty: 'No invites yet.' },
];

/**
 * Pending invites by default: once an invite is accepted, expires or is revoked it drops out of
 * the default view. The other statuses stay on record and can be shown with the filter.
 */
function InvitesSection() {
  const [show, setShow] = useState<InviteStatus | ''>('pending');
  const { data: invites, setData: setInvites, ...load } = useLatestLoad<Invite[]>(() => listInvites(show || undefined), [show]);
  // The filter on screen now, for a create that finishes after the admin switched filters.
  const showRef = useRef(show);
  showRef.current = show;
  const changeShow = (next: InviteStatus | '') => {
    // Drop the old filter's rows so they are never shown (or revoked) under the new filter.
    setInvites(null);
    setShow(next);
  };
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ code: string; label: string | null } | null>(null);
  const create = useAction();
  const revoke = useAction();

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      const result = await createInvite(label.trim());
      setCreated({ code: result.code, label: result.invite.label });
      setLabel('');
      // A new invite is pending, so it belongs only in the Pending and All views.
      if (showRef.current === 'pending' || showRef.current === '') setInvites((list) => [result.invite, ...(list ?? [])]);
    });
  };

  const onRevoke = (invite: Invite) => {
    const name = invite.label ? `the invite for ${invite.label}` : 'this invite';
    if (!window.confirm(`Revoke ${name}? The code will stop working.`)) return;
    void revoke.run(async () => {
      try {
        await revokeInvite(invite.id);
        // Update the row now, so it cannot be revoked again before the reload lands.
        setInvites((list) =>
          showRef.current === 'pending'
            ? (list ?? []).filter((i) => i.id !== invite.id)
            : (list ?? []).map((i) => (i.id === invite.id ? { ...i, status: 'revoked' } : i)),
        );
      } finally {
        // Also on failure: INVITE_NOT_REVOCABLE means the row is stale (it expired or was used).
        load.retry();
      }
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

      <label>
        Show
        <select value={show} onChange={(e) => changeShow(e.target.value as InviteStatus | '')}>
          {INVITE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <ErrorText error={load.error ?? revoke.error} />
      {invites === null ? (
        <FirstLoad what="invites" error={load.error} busy={load.busy} retry={load.retry} />
      ) : invites.length === 0 ? (
        <p className="muted">{INVITE_FILTERS.find((f) => f.value === show)?.empty}</p>
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
                    <button type="button" className="danger" disabled={revoke.busy || load.busy} onClick={() => onRevoke(invite)}>
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
  const { data: users, setData: setUsers, ...load } = useLatestLoad<UserPage>(() => listUsers(page, PAGE_SIZE), [page]);
  const [filter, setFilter] = useState('');
  const [reset, setReset] = useState<{ user: AdminUser; password: string; passphrase: string } | null>(null);
  const act = useAction();

  const replace = (updated: AdminUser) =>
    setUsers((p) => (p ? { ...p, data: p.data.map((u) => (u.id === updated.id ? updated : u)) } : p));

  const changeRole = (target: AdminUser, role: User['role']) => {
    const question =
      role === 'admin'
        ? `Make ${target.displayName} (${target.username}) an admin? They will be able to manage invites, roles and accounts.`
        : `Remove admin from ${target.displayName} (${target.username})?`;
    if (!window.confirm(question)) return;
    void act.run(async () => replace(await setUserRole(target.id, role)));
  };

  const resetUser = (target: AdminUser) => {
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
        <FirstLoad what="users" error={load.error} busy={load.busy} retry={load.retry} />
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

const BUG_PAGE_SIZE = 20;

/**
 * Bug reports, newest first; open ones by default. Each opens to show the captured context for
 * debugging, and can be dismissed once handled (or reopened).
 */
function BugReportsSection() {
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState<BugSeverity | ''>('');
  const [status, setStatus] = useState<BugStatus | ''>('open');
  const { data: reports, setData: setReports, ...load } = useLatestLoad<BugReportPage>(
    () => listBugReports(page, BUG_PAGE_SIZE, severity || undefined, status || undefined),
    [page, severity, status],
  );
  const act = useAction();

  const pages = reports ? Math.max(1, Math.ceil(reports.total / reports.limit)) : 1;
  // Dismissing the last report on the last page empties it: step back to the new last page.
  useEffect(() => {
    if (reports && page > pages) setPage(pages);
  }, [reports, page, pages]);

  const resolve = (report: AdminBugReport, resolution: BugResolution | null) =>
    void act.run(async () => {
      const updated = await setBugResolution(report.id, resolution);
      // Update the row now, so its button cannot be pressed again before the reload lands. In the
      // Open or Dismissed view it leaves the list; the reload then fixes the total and paging.
      const moved = status !== '' && (updated.resolution ? 'dismissed' : 'open') !== status;
      setReports((p) =>
        p
          ? {
              ...p,
              data: moved ? p.data.filter((x) => x.id !== updated.id) : p.data.map((x) => (x.id === updated.id ? updated : x)),
            }
          : p,
      );
      load.retry();
    });

  return (
    <section>
      <h2>Bug reports</h2>
      <label>
        Show
        <select
          value={status}
          onChange={(e) => {
            setReports(null);
            setStatus(e.target.value as BugStatus | '');
            setPage(1);
          }}
        >
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="">All</option>
        </select>
      </label>
      <label>
        Severity
        <select
          value={severity}
          onChange={(e) => {
            setReports(null);
            setSeverity(e.target.value as BugSeverity | '');
            setPage(1);
          }}
        >
          <option value="">All</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <ErrorText error={load.error ?? act.error} />
      {reports === null ? (
        <FirstLoad what="bug reports" error={load.error} busy={load.busy} retry={load.retry} />
      ) : (
        <>
          <p className="muted">
            {reports.total} {status ? `${status} ` : ''}report{reports.total === 1 ? '' : 's'}
          </p>
          <ul className="bug-list">
            {reports.data.map((r) => (
              <BugReportItem key={r.id} report={r} busy={act.busy || load.busy} onResolve={(resolution) => resolve(r, resolution)} />
            ))}
          </ul>
          {pages > 1 && (
            <nav className="actions spaced" aria-label="Bug report pages">
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

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function BugReportItem({
  report: r,
  busy,
  onResolve,
}: {
  report: AdminBugReport;
  busy: boolean;
  onResolve(resolution: BugResolution | null): void;
}) {
  const [choice, setChoice] = useState<BugResolution>('resolved');
  const ctx = r.context;
  const round = typeof ctx.round_number === 'number' ? ctx.round_number : null;
  const trick = typeof ctx.trick_number === 'number' ? ctx.trick_number : null;
  const who = r.reporter ? `${r.reporter.displayName ?? '?'} (${r.reporter.username ?? '?'})` : 'Unknown user';
  return (
    <li className="card bug-item">
      <div className="card-head">
        <span className={`badge sev-${r.severity ?? 'none'}`}>{r.severity ?? 'no severity'}</span>
        {r.resolution && <span className="badge dismissed">{BUG_RESOLUTION_LABELS[r.resolution]}</span>}
        <span className="muted">{formatDate(r.createdAt)}</span>
      </div>
      <p className="bug-desc">{r.description}</p>
      <dl className="facts">
        <dt>From</dt>
        <dd>{who}</dd>
        <dt>Page</dt>
        <dd>{str(ctx.page) ?? '—'}</dd>
        {round !== null && (
          <>
            <dt>Round</dt>
            <dd>
              {round}
              {trick !== null && `, trick ${trick}`}
            </dd>
          </>
        )}
      </dl>
      <CopyValue label="Trace ID" value={r.traceId} />
      <details>
        <summary>Full context</summary>
        <dl className="facts">
          <dt>URL</dt>
          <dd>{str(ctx.url) ?? '—'}</dd>
          <dt>Room</dt>
          <dd>{r.roomId ?? '—'}</dd>
          <dt>Game</dt>
          <dd>{r.gameId ?? '—'}</dd>
          <dt>Browser</dt>
          <dd>{str(ctx.user_agent) ?? '—'}</dd>
          <dt>Sent at</dt>
          <dd>{formatDate(str(ctx.client_timestamp))} (device clock)</dd>
        </dl>
        {ctx.game_state_summary != null && (
          <>
            <h3 className="hint">Reporter&apos;s game view</h3>
            <pre className="json">{JSON.stringify(ctx.game_state_summary, null, 2)}</pre>
          </>
        )}
      </details>
      {r.resolution ? (
        <div className="actions">
          <span className="hint">
            Dismissed as {BUG_RESOLUTION_LABELS[r.resolution].toLowerCase()}
            {r.resolvedBy && ` by ${r.resolvedBy.displayName ?? r.resolvedBy.username ?? '?'}`}, {formatDate(r.resolvedAt)}
          </span>
          <button type="button" disabled={busy} onClick={() => onResolve(null)}>
            Reopen
          </button>
        </div>
      ) : (
        <div className="actions">
          <label>
            <span className="visually-hidden">Resolution</span>
            <select value={choice} onChange={(e) => setChoice(e.target.value as BugResolution)}>
              {(Object.keys(BUG_RESOLUTION_LABELS) as BugResolution[]).map((key) => (
                <option key={key} value={key}>
                  {BUG_RESOLUTION_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => onResolve(choice)}>
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}
