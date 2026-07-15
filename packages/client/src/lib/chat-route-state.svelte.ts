class ChatRouteState {
  sessionId = $state<string | null>(null);
  active = $state(false);

  enter(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.active = true;
  }

  setSession(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  leave(): void {
    this.active = false;
  }
}

export const chatRouteState = new ChatRouteState();
