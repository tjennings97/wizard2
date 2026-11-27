import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { submitBugReport, type BugReportContext, type BugSeverity } from '../api/bugReports';
import { useGame } from '../context/GameContext';
import { useRealtime } from '../context/SocketContext';
import { errorsOf, useSubmit } from '../hooks/useSubmit';

/** Same limit as the server (POST /bug-reports `description`). */
const DESCRIPTION_MAX = 2000;

/** Screen name from the route: lobby, room, game, profile, admin, or other. */
function pageOf(pathname: string): string {
  if (pathname === '/') return 'lobby';
  const first = pathname.split('/')[1];
  return ['room', 'game', 'profile', 'admin'].includes(first) ? first : 'other';
}

/**
 * "Report a bug": a footer button on every signed-in screen (docs/product/prd.md, Bug Reporting)
 * that opens a short form. The report carries where the user is; the server adds the rest.
 */
export function BugReport() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  return (
    <footer className="app-foot">
      <button ref={trigger} type="button" className="link" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Report a bug
      </button>
      {open && <BugReportDialog onClose={close} />}
    </footer>
  );
}

function BugReportDialog({ onClose }: { onClose(): void }) {
  const id = useId();
  const { pathname } = useLocation();
  const { room } = useRealtime();
  const { game } = useGame();
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<BugSeverity | ''>('');
  const [sent, setSent] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const done = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (sent ? done : textarea).current?.focus();
  }, [sent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const validate = useCallback(
    () =>
      errorsOf({
        description:
          description.trim().length === 0
            ? 'Tell us what went wrong.'
            : description.trim().length > DESCRIPTION_MAX && `At most ${DESCRIPTION_MAX} characters.`,
      }),
    [description],
  );

  const send = useCallback(async () => {
    // Captured at the moment of sending, so it matches what was on screen.
    const context: BugReportContext = {
      url: window.location.href,
      page: pageOf(pathname),
      roomId: game?.roomId ?? room?.roomId ?? null,
      gameId: game?.gameId ?? null,
      roundNumber: game && game.roundNumber > 0 ? game.roundNumber : null,
      trickNumber: game?.trick?.trickNumber ?? null,
      userAgent: navigator.userAgent,
      clientTimestamp: new Date().toISOString(),
    };
    const res = await submitBugReport({ description: description.trim(), severity: severity || undefined, context });
    setSent(res.message);
  }, [description, severity, pathname, game, room]);

  const { busy, error, fields, onSubmit } = useSubmit(send, validate);
  const descError = fields.description;

  return (
    <div
      className="overlay bug-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <h2 id={`${id}-title`}>Report a bug</h2>
        {sent ? (
          <>
            <p className="notice" role="status">
              {sent}
            </p>
            <div className="modal-foot">
              <span />
              <button ref={done} type="button" className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit} className="stack" noValidate>
            <label>
              What went wrong?
              <textarea
                ref={textarea}
                rows={5}
                maxLength={DESCRIPTION_MAX}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-invalid={descError ? true : undefined}
                aria-describedby={`${id}-hint${descError ? ` ${id}-error` : ''}`}
              />
              <span id={`${id}-hint`} className="hint">
                What you did and what happened. The page you are on and your current game are attached
                automatically.
              </span>
              {descError && (
                <span id={`${id}-error`} className="field-error">
                  {descError}
                </span>
              )}
            </label>
            <label>
              How bad is it? (optional)
              <select value={severity} onChange={(e) => setSeverity(e.target.value as BugSeverity | '')}>
                <option value="">Not sure</option>
                <option value="low">Low: a small annoyance</option>
                <option value="medium">Medium: something does not work</option>
                <option value="high">High: I cannot play</option>
              </select>
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-foot">
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
