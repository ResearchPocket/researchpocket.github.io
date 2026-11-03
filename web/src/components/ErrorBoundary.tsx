import { Component, type ReactNode } from "react";

/**
 * A rendering error would otherwise unmount the whole app and leave a blank
 * screen until the PWA is restarted. This keeps a way out and the message.
 * Local data is untouched: everything is already committed to IndexedDB.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="boot-shell" role="alert">
        <span aria-hidden="true" className="welcome-monogram">rp</span>
        <h1>Something went wrong</h1>
        <button className="primary-button" onClick={() => window.location.reload()} type="button">
          Reload
        </button>
        <details>
          <summary>Details</summary>
          <code>{error.message || String(error)}</code>
        </details>
      </main>
    );
  }
}
