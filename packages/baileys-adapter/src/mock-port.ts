import type { PortEvent } from "./events.js";
import type { BaileysSocketPort, PortEventListener } from "./port.js";

/** Deterministic in-memory port for tests and CI. Never touches the network. */
export class MockSocketPort implements BaileysSocketPort {
  private readonly listeners = new Set<PortEventListener>();
  closed = false;
  loggedOut = false;
  readonly pairingRequests: string[] = [];

  onEvent(listener: PortEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  requestPairingCode(phoneNumber: string): Promise<string> {
    this.pairingRequests.push(phoneNumber);
    return Promise.resolve("SYNT-H123");
  }

  close(): void {
    this.closed = true;
  }

  logout(): Promise<void> {
    this.loggedOut = true;
    return Promise.resolve();
  }

  emit(event: PortEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
