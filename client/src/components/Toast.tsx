import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** docs/design/ui-foundation.md, "Toast / notification". */
export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  leaving: boolean;
}

interface ToastValue {
  /** Shows a toast for 3 seconds (tap × to close sooner). */
  toast(message: string, variant?: ToastVariant): void;
}

/** How long a toast stays up, and how long its slide-out runs (--duration-normal). */
export const TOAST_MS = 3000;
const LEAVE_MS = 250;
/** Older toasts drop off once this many are showing. */
const MAX_TOASTS = 3;

const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      later(() => setItems((list) => list.filter((t) => t.id !== id)), LEAVE_MS);
    },
    [later],
  );

  const toast = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = nextId.current++;
      setItems((list) => [...list, { id, message, variant, leaving: false }].slice(-MAX_TOASTS));
      later(() => dismiss(id), TOAST_MS);
    },
    [dismiss, later],
  );

  const value = useMemo(() => ({ toast }), [toast]);
  const renderToast = (t: ToastItem) => (
    <div key={t.id} className={`toast ${t.variant}${t.leaving ? ' leaving' : ''}`}>
      <p>{t.message}</p>
      <button type="button" className="ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Two live regions that are always in the page, so screen readers announce what is added to
          them (a region that mounts already filled is often skipped). Errors interrupt; the rest
          wait their turn. */}
      <div className="toasts">
        <div className="toast-region" role="alert" aria-live="assertive">
          {items.filter((t) => t.variant === 'error').map(renderToast)}
        </div>
        <div className="toast-region" role="status" aria-live="polite">
          {items.filter((t) => t.variant !== 'error').map(renderToast)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}
