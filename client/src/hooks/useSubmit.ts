import { useCallback, useState, type FormEvent } from 'react';
import { ApiRequestError } from '../api/http';

export type FieldErrors = Record<string, string>;

/**
 * Form submission: runs `fn` once at a time and keeps a form-level error plus per-field errors
 * (client checks from `validate`, or the server's VALIDATION_ERROR details.fields).
 */
export function useSubmit(fn: () => Promise<unknown>, validate?: () => FieldErrors) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});

  const onSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const local = validate?.() ?? {};
      setFields(local);
      setError(null);
      if (Object.keys(local).length > 0) return false;
      setBusy(true);
      try {
        await fn();
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError && Object.keys(err.fields).length > 0) {
          setFields(err.fields);
          setError('Please fix the highlighted fields.');
        } else {
          setError(err instanceof Error ? err.message : 'Something went wrong.');
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fn, validate],
  );

  return { busy, error, fields, onSubmit };
}

/** Same rules as the server (BodyValidator.newSecret): 8+ characters, at most 72 UTF-8 bytes. */
export function secretError(value: string): string | undefined {
  if (value.length < 8) return 'Must be at least 8 characters.';
  if (new TextEncoder().encode(value).length > 72) return 'Must be at most 72 bytes.';
  return undefined;
}

/** Collects the non-empty entries of a set of field checks. */
export function errorsOf(checks: Record<string, string | undefined | false>): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(checks)) if (v) out[k] = v;
  return out;
}
