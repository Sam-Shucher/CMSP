import React, { useCallback, useEffect, useRef, useState } from 'react';

// How long someone has to stop typing before we point out a problem.
export const FIELD_IDLE_MS = 3000;

type Validator<V> = (value: string, all: V) => string | null;
export type Validators<V> = Partial<Record<keyof V, Validator<V>>>;

// Form state with polite validation. A field's error is only shown:
//   • after the person stops typing in it for FIELD_IDLE_MS,
//   • when they leave the field (if they typed in it), or
//   • when they try to submit (validateAll).
// Editing a field hides its error again until the next pause, so nobody is
// scolded mid-keystroke. Forms using this should also set noValidate, so the
// browser's own popups never appear.
export function useValidatedForm<V extends Record<string, string>>(initial: V, validators: Validators<V>) {
  const [values, setValues] = useState<V>(initial);
  const [visible, setVisible] = useState<Partial<Record<keyof V, boolean>>>({});
  const valuesRef = useRef<V>(initial);
  const edited = useRef<Set<keyof V>>(new Set());
  const timers = useRef<Map<keyof V, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const show = useCallback((name: keyof V, shown: boolean): void => {
    setVisible(prev => (Boolean(prev[name]) === shown ? prev : { ...prev, [name]: shown }));
  }, []);

  const setValue = useCallback((name: keyof V, value: string): void => {
    valuesRef.current = { ...valuesRef.current, [name]: value };
    setValues(valuesRef.current);
    edited.current.add(name);
    show(name, false);

    clearTimeout(timers.current.get(name));
    timers.current.set(name, setTimeout(() => {
      timers.current.delete(name);
      show(name, true);
    }, FIELD_IDLE_MS));
  }, [show]);

  const blur = useCallback((name: keyof V): void => {
    if (!edited.current.has(name)) return;
    clearTimeout(timers.current.get(name));
    timers.current.delete(name);
    show(name, true);
  }, [show]);

  function problemWith(name: keyof V, current: V): string | null {
    return validators[name]?.(current[name], current) ?? null;
  }

  function errorFor(name: keyof V): string | null {
    return visible[name] ? problemWith(name, values) : null;
  }

  // Shows every field's problem at once. True when there are none.
  function validateAll(): boolean {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    const names = Object.keys(validators) as (keyof V)[];
    setVisible(prev => ({ ...prev, ...Object.fromEntries(names.map(n => [n, true])) }));
    return names.every(name => problemWith(name, valuesRef.current) === null);
  }

  // Everything an <input> needs: <input {...field('email', 'login-email')} />
  function field(name: keyof V, id: string) {
    const error = errorFor(name);
    return {
      id,
      value: values[name],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(name, e.target.value),
      onBlur: () => blur(name),
      'aria-invalid': error !== null,
      'aria-describedby': `${id}-error`,
    };
  }

  // Start over from the starting values (or from `next`, e.g. data loaded from
  // the server), as if nothing had been typed — no messages, no pending checks.
  function reset(next: V = initial): void {
    timers.current.forEach(clearTimeout);
    timers.current.clear();
    edited.current.clear();
    valuesRef.current = next;
    setValues(next);
    setVisible({});
  }

  return { values, setValue, blur, errorFor, validateAll, field, reset };
}
