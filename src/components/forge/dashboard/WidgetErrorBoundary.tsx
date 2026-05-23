// WidgetErrorBoundary — contains widget crashes to the widget's
// own card so a single bad component (bad spec from the agent,
// upstream library API change, malformed payload) can't blank
// out the whole Forge preview pane.
//
// React class component because hooks-based error catching doesn't
// exist yet — componentDidCatch is still the only path to a real
// boundary that catches descendant render exceptions.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Label to show in the failure card so the user knows which
   *  widget broke. */
  widgetLabel: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export default class WidgetErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error?.message ?? String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged to the dev console so anyone debugging can find the
    // stack. We deliberately don't try to ship the trace upstream
    // — widget crashes are usually local config issues, not
    // platform bugs.
    console.error(
      `WidgetErrorBoundary[${this.props.widgetLabel}]:`,
      error,
      info?.componentStack,
    );
  }

  componentDidUpdate(prevProps: Props): void {
    // If the parent swaps in a new widget (different label), give
    // it a fresh chance to render — reset the trapped error state.
    if (prevProps.widgetLabel !== this.props.widgetLabel && this.state.hasError) {
      this.setState({ hasError: false, errorMessage: "" });
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          padding: 14,
          background: "rgba(248,113,113,0.08)",
          border: "1px solid rgba(248,113,113,0.3)",
          borderRadius: 4,
          fontSize: 12,
          color: "var(--fg-dim)",
        }}
      >
        <div
          style={{
            color: "var(--err, #f87171)",
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          Widget &ldquo;{this.props.widgetLabel}&rdquo; crashed
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflow: "auto",
          }}
        >
          {this.state.errorMessage}
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
          The rest of the dashboard still works. Ask the agent to fix or
          remove this widget, or open the dashboard JSON directly under
          <code> ~/auracle/forge/dashboards/</code>.
        </div>
      </div>
    );
  }
}
