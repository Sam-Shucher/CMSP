import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// React prints the caught error to the console on purpose; quiet it so a
// passing run isn't full of red.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function Boom(): React.ReactElement {
  throw new Error('render exploded: cannot read properties of undefined');
}

describe('ErrorBoundary', () => {
  it('shows its children when nothing is wrong', () => {
    render(<ErrorBoundary><p>The Collection</p></ErrorBoundary>);

    expect(screen.getByText('The Collection')).toBeInTheDocument();
  });

  // Without this, one bad render is a blank white page — on a phone, with no
  // console to look at and no way back.
  it('catches a render that throws and offers a way out', () => {
    render(<ErrorBoundary onReload={vi.fn()}><Boom /></ErrorBoundary>);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('reloads the page when asked', () => {
    const onReload = vi.fn();
    render(<ErrorBoundary onReload={onReload}><Boom /></ErrorBoundary>);

    fireEvent.click(screen.getByRole('button', { name: /reload/i }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // The message is for whoever is holding the phone, not for a stack trace.
  it('does not put the raw error message on the page', () => {
    render(<ErrorBoundary onReload={vi.fn()}><Boom /></ErrorBoundary>);

    expect(screen.queryByText(/cannot read properties/i)).not.toBeInTheDocument();
  });

  it('still logs the error so it can be found in the console', () => {
    render(<ErrorBoundary onReload={vi.fn()}><Boom /></ErrorBoundary>);

    expect(console.error).toHaveBeenCalled();
  });
});
