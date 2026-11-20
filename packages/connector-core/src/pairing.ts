export type PairingPhase = "idle" | "awaiting-qr" | "awaiting-code" | "paired" | "logged-out" | "timed-out";

/** Internal state: `qr` is a secret and lives in memory only. */
export interface PairingState {
  readonly phase: PairingPhase;
  readonly qrAttempts: number;
  readonly qr?: string;
}

/** What may cross IPC / reach the UI as state. The QR payload itself is a separate, transient event. */
export interface PairingSnapshot {
  readonly phase: PairingPhase;
  readonly qrAttempts: number;
  readonly hasQr: boolean;
}

export type PairingEvent =
  | { readonly type: "qr"; readonly qr: string }
  | { readonly type: "code-requested" }
  | { readonly type: "paired" }
  | { readonly type: "logged-out" }
  | { readonly type: "reset" };

export const INITIAL_PAIRING_STATE: PairingState = { phase: "idle", qrAttempts: 0 };

export function pairingReducer(
  state: PairingState,
  event: PairingEvent,
  maxQrAttempts: number,
): PairingState {
  switch (event.type) {
    case "qr": {
      if (state.phase === "paired" || state.phase === "logged-out") {
        return state;
      }
      const attempts = state.qrAttempts + 1;
      if (attempts > maxQrAttempts) {
        return { phase: "timed-out", qrAttempts: state.qrAttempts };
      }
      return { phase: "awaiting-qr", qrAttempts: attempts, qr: event.qr };
    }
    case "code-requested":
      return state.phase === "paired" ? state : { phase: "awaiting-code", qrAttempts: state.qrAttempts };
    case "paired":
      return { phase: "paired", qrAttempts: 0 };
    case "logged-out":
      return { phase: "logged-out", qrAttempts: 0 };
    case "reset":
      return INITIAL_PAIRING_STATE;
  }
}

export function pairingSnapshot(state: PairingState): PairingSnapshot {
  return { phase: state.phase, qrAttempts: state.qrAttempts, hasQr: state.qr !== undefined };
}
