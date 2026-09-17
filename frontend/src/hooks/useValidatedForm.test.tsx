import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useValidatedForm, FIELD_IDLE_MS } from './useValidatedForm';

type Fields = { email: string; password: string; confirm: string };

const validators = {
  email: (v: string) => (v.includes('@') ? null : 'Enter an email like name@example.com'),
  password: (v: string) => (v.length >= 8 ? null : 'Use at least 8 characters'),
  confirm: (v: string, all: Fields) => (v === all.password ? null : 'Passwords don\'t match'),
};

function setup() {
  return renderHook(() => useValidatedForm<Fields>({ email: '', password: '', confirm: '' }, validators));
}

describe('useValidatedForm', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits 3 seconds after typing stops', () => {
    expect(FIELD_IDLE_MS).toBe(3000);
  });

  it('shows nothing while you are still typing', () => {
    const { result } = setup();

    act(() => result.current.setValue('email', 'a'));
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => result.current.setValue('email', 'ab'));
    act(() => { vi.advanceTimersByTime(2500); });

    expect(result.current.errorFor('email')).toBeNull();
  });

  it('shows the error once you pause for 3 seconds', () => {
    const { result } = setup();

    act(() => result.current.setValue('email', 'abc'));
    act(() => { vi.advanceTimersByTime(FIELD_IDLE_MS); });

    expect(result.current.errorFor('email')).toBe('Enter an email like name@example.com');
  });

  it('shows the error when you leave the field', () => {
    const { result } = setup();

    act(() => result.current.setValue('email', 'abc'));
    act(() => result.current.blur('email'));

    expect(result.current.errorFor('email')).toMatch(/name@example.com/);
  });

  it('does not complain about a field you only clicked through without typing', () => {
    const { result } = setup();

    act(() => result.current.blur('email'));

    expect(result.current.errorFor('email')).toBeNull();
  });

  it('hides a shown error as soon as you start fixing it, and brings it back only after another pause', () => {
    const { result } = setup();
    act(() => result.current.setValue('email', 'abc'));
    act(() => result.current.blur('email'));

    act(() => result.current.setValue('email', 'abc@'));
    expect(result.current.errorFor('email')).toBeNull();

    act(() => result.current.setValue('email', 'abcd'));
    act(() => { vi.advanceTimersByTime(FIELD_IDLE_MS); });
    expect(result.current.errorFor('email')).not.toBeNull();
  });

  it('never shows an error for a value that is fine', () => {
    const { result } = setup();

    act(() => result.current.setValue('email', 'me@example.com'));
    act(() => result.current.blur('email'));
    act(() => { vi.advanceTimersByTime(FIELD_IDLE_MS); });

    expect(result.current.errorFor('email')).toBeNull();
  });

  it('validateAll shows every problem at once and reports whether the form is OK', () => {
    const { result } = setup();

    let ok = true;
    act(() => { ok = result.current.validateAll(); });

    expect(ok).toBe(false);
    expect(result.current.errorFor('email')).not.toBeNull();
    expect(result.current.errorFor('password')).not.toBeNull();

    act(() => {
      result.current.setValue('email', 'me@example.com');
      result.current.setValue('password', 'longenough');
      result.current.setValue('confirm', 'longenough');
    });
    act(() => { ok = result.current.validateAll(); });
    expect(ok).toBe(true);
  });

  it('checks fields against each other using the latest values', () => {
    const { result } = setup();
    act(() => {
      result.current.setValue('password', 'longenough');
      result.current.setValue('confirm', 'longenough');
    });
    act(() => { result.current.validateAll(); });
    expect(result.current.errorFor('confirm')).toBeNull();

    act(() => result.current.setValue('password', 'different1'));

    expect(result.current.errorFor('confirm')).toBe('Passwords don\'t match');
  });

  it('gives inputs the props they need: value, change and blur handlers, and accessible error wiring', () => {
    const { result } = setup();
    act(() => result.current.setValue('email', 'abc'));
    act(() => result.current.blur('email'));

    const props = result.current.field('email', 'login-email');

    expect(props.value).toBe('abc');
    expect(props['aria-invalid']).toBe(true);
    expect(props['aria-describedby']).toBe('login-email-error');

    act(() => props.onChange({ target: { value: 'abc@x.co' } } as React.ChangeEvent<HTMLInputElement>));
    expect(result.current.values.email).toBe('abc@x.co');
    expect(result.current.field('email', 'login-email')['aria-invalid']).toBe(false);
  });

  it('reset empties the form without then complaining that it\'s empty', () => {
    const { result } = setup();
    act(() => result.current.setValue('email', 'me@example.com'));

    act(() => result.current.reset());
    act(() => { vi.advanceTimersByTime(FIELD_IDLE_MS); });
    act(() => result.current.blur('email'));

    expect(result.current.values.email).toBe('');
    expect(result.current.errorFor('email')).toBeNull();
  });

  it('reset can load new values (like a saved profile) without flagging them', () => {
    const { result } = setup();

    act(() => result.current.reset({ email: 'loaded', password: '', confirm: '' }));
    act(() => { vi.advanceTimersByTime(FIELD_IDLE_MS); });

    expect(result.current.values.email).toBe('loaded');
    expect(result.current.errorFor('email')).toBeNull();
  });

  it('cancels pending timers when the form goes away', () => {
    const { result, unmount } = setup();
    act(() => result.current.setValue('email', 'abc'));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
