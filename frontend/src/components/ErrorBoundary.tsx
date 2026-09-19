import React from 'react';

// A render that throws anywhere below this leaves a blank white page, which on
// a phone means no console, no error, and no way back except knowing to close
// the tab. This catches it and offers the one thing that reliably helps.

type Props = {
  children: React.ReactNode;
  onReload?: () => void; // injectable so a test doesn't have to reload jsdom
};

type State = { failed: boolean };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Whoever is holding the phone can't use this, but it's in the console for
    // anyone who goes looking.
    console.error('Unhandled error in the page:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    const reload = this.props.onReload ?? (() => window.location.reload());

    return (
      <div style={{ padding: '60px 24px', textAlign: 'center', color: '#8a7d6a' }}>
        <p style={{ fontSize: '20px', color: '#c9a84c', marginBottom: '8px' }}>Something went wrong</p>
        <p style={{ fontSize: '14px', marginBottom: '20px' }}>
          This page stopped working. Reloading usually sorts it out — nothing you did is lost.
        </p>
        <button type="button" className="btn-primary" onClick={reload}>Reload the page</button>
      </div>
    );
  }
}
