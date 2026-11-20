import type { PortEvent } from "./events.js";

export type PortEventListener = (event: PortEvent) => void;

/**
 * The ONLY surface the connector may use to talk to WhatsApp. It is read-only by construction:
 * connection lifecycle, pairing, and passive observation of history/live events.
 * There is intentionally no method that sends, edits, deletes, reacts, marks read, or sets presence.
 */
export interface BaileysSocketPort {
  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: PortEventListener): () => void;
  /** Request a phone-number pairing code as an alternative to QR. Number is digits only. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  /** Close the transport without unlinking the device. */
  close(): void;
  /** Unlink this linked device from the account. Only invoked by an explicit user logout. */
  logout(): Promise<void>;
}

export const READ_ONLY_PORT_METHODS = [
  "onEvent",
  "requestPairingCode",
  "close",
  "logout",
] as const satisfies readonly (keyof BaileysSocketPort)[];

export type PortFactory = (auth: PortAuthState) => BaileysSocketPort | Promise<BaileysSocketPort>;

/** Opaque auth state handed to Baileys; the connector owns persistence (see ProtectedStore). */
export interface PortAuthState {
  readonly creds: Record<string, unknown>;
  readonly keys: {
    get(type: string, ids: string[]): Promise<Record<string, unknown>> | Record<string, unknown>;
    set(data: Record<string, Record<string, unknown> | undefined>): Promise<void> | void;
  };
}
