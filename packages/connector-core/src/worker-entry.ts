import { createBaileysPort, createInitialCreds } from "@social-explorer/baileys-adapter";
import { KeyringKeyStore, ProtectedStore } from "@social-explorer/security";
import { parseConnectorConfig } from "./config.js";
import { ProtectedAuthState } from "./protected-auth-state.js";
import { runConnectorWorker } from "./worker.js";

/**
 * Child-process entry point, started only by `ConnectorSupervisor` via `child_process.fork`.
 * Configuration arrives through two environment variables set by the supervisor.
 */
function main(): void {
  if (process.send === undefined) {
    process.exit(2);
  }
  const authDirectory = process.env["SE_CONNECTOR_AUTH_DIR"];
  if (authDirectory === undefined || authDirectory.length === 0) {
    process.exit(2);
  }
  const config = parseConnectorConfig(JSON.parse(process.env["SE_CONNECTOR_CONFIG"] ?? "{}"));
  const store = new ProtectedStore({ directory: authDirectory, keyStore: new KeyringKeyStore() });
  runConnectorWorker({
    config,
    openAuth: () => ProtectedAuthState.open(store, createInitialCreds),
    createPort: createBaileysPort,
    channel: {
      send: (event) => {
        process.send?.(event);
      },
      onMessage: (handler) => {
        process.on("message", handler);
      },
      exit: (code) => {
        process.exit(code);
      },
    },
  });
  process.on("disconnect", () => {
    process.exit(0);
  });
}

main();
