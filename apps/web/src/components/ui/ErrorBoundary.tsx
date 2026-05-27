"use client";

import { Component, ReactNode } from "react";
import SectionError from "./SectionError";

interface Props {
  children: ReactNode;
  /** Custom fallback render. If omitted, a generic SectionError is shown. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional logging hook — fires when a render error is captured. */
  onError?: (error: Error, info: { componentStack?: string }) => void;
}

interface State {
  error: Error | null;
}

/**
 * Section-level error boundary. Catches render-time crashes within a single
 * settings section so one buggy section doesn't blank the whole page.
 *
 * Pair this around individual sections in SettingsPage/AccountSettingsPage:
 *   <ErrorBoundary><ProfileSection ... /></ErrorBoundary>
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    this.props.onError?.(error, info);
    // eslint-disable-next-line no-console -- intentional last-resort log
    console.error("Section render error:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <SectionError
          title="Something went wrong"
          message="This section couldn't render. Refreshing usually helps."
          onRetry={this.reset}
          retryLabel="Reload section"
        />
      );
    }
    return this.props.children;
  }
}
