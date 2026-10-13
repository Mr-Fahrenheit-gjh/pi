"use client";

import { Component, type ReactNode } from "react";

interface Props {
  transitionKey: string | number;
  children: ReactNode;
}
interface State {
  displayedKey: Props["transitionKey"];
  displayedChildren: ReactNode;
}

/** Presentation only: selection, URL and the running agent stay owned by AppShell. */
export class ConversationTransition extends Component<Props, State> {
  state: State = {
    displayedKey: this.props.transitionKey,
    displayedChildren: this.props.children,
  };
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Keep the last committed view fresh without remounting it on streamed updates.
    return props.transitionKey === state.displayedKey
      ? { displayedChildren: props.children }
      : null;
  }

  componentDidUpdate() {
    if (this.props.transitionKey === this.state.displayedKey) {
      this.clearExit();
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.clearExit();
      this.showLatest();
    } else if (this.exitTimer === null) {
      // One bounded exit, not a queue: rapid clicks always land on the latest pick.
      this.exitTimer = setTimeout(this.showLatest, 80);
    }
  }

  componentWillUnmount() {
    this.clearExit();
  }

  private clearExit = () => {
    if (this.exitTimer !== null) clearTimeout(this.exitTimer);
    this.exitTimer = null;
  };

  private showLatest = () => {
    this.exitTimer = null;
    this.setState({
      displayedKey: this.props.transitionKey,
      displayedChildren: this.props.children,
    });
  };

  render() {
    const leaving = this.props.transitionKey !== this.state.displayedKey;
    return (
      <div
        className={`conversation-transition${leaving ? " is-leaving" : ""}`}
        data-conversation-key={this.state.displayedKey}
        inert={leaving}
        aria-busy={leaving || undefined}
      >
        {this.state.displayedChildren}
      </div>
    );
  }
}
