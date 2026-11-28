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
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          // Errors interrupt (alert); the rest wait their turn (status).
          <div key={t.id} className={`toast ${t.variant}${t.leaving ? ' leaving' : ''}`} role={t.variant === 'error' ? 'alert' : 'status'}>
            <p>{t.message}</p>
            <button type="button" className="ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}
