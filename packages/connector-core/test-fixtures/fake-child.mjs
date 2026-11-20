// Synthetic stand-in for worker-entry.js used by supervisor tests. Speaks the connector IPC protocol.
import { existsSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "healthy";
const marker = process.env.FAKE_MARKER;
const send = (message) => process.send?.(message);
let seq = 0;

const emptyState = {
  phase: "open",
  pairing: { phase: "paired", qrAttempts: 0, hasQr: false },
  reconnectAttempt: 0,
  history: { status: "not-started", batchesApplied: 0, messagesIngested: 0, duplicatesSkipped: 0, warnings: [] },
};

const checkpoint = {
  version: 1,
  datasetId: "ds_synthetic",
  historyStatus: "syncing",
  historyBatchesApplied: 1,
  historyWarnings: [],
  newestByConversation: {},
  recentMessageIds: ["msg_a"],
  updatedAtMs: 1,
};

const validBatch = {
  datasetId: "ds_synthetic",
  source: "baileys-live",
  conversations: [],
  contacts: [],
  participants: [],
  messages: [],
  reactions: [],
  removedReactionIds: [],
  edits: [],
  deletedMessageIds: [],
  deletedConversationIds: [],
  checkpoint,
};

let crashFirst = false;
if (mode === "crash-once" && marker !== undefined) {
  if (!existsSync(marker)) {
    writeFileSync(marker, "crashed");
    crashFirst = true;
  }
}

send({ type: "ready", protocolVersion: 1, pid: process.pid });

if (mode !== "hang") {
  setInterval(() => send({ type: "heartbeat", seq: seq++, atMs: Date.now() }), 25);
}

process.on("message", (message) => {
  switch (message?.type) {
    case "start":
      send({ type: "state", state: emptyState });
      if (mode === "crash-always" || crashFirst) {
        setTimeout(() => process.exit(1), 10);
      }
      if (mode === "garbage") {
        send({ type: "execute", command: "rm -rf /" });
      }
      if (mode === "invalid-batch-crash") {
        send({ type: "ingest", seq: 0, batch: { ...validBatch, checkpoint: undefined } });
        setTimeout(() => process.exit(1), 10);
      }
      if (mode === "ingest") {
        send({ type: "ingest", seq: 0, batch: validBatch });
      }
      if (mode === "crash-after-qr") {
        send({ type: "qr", qr: "synthetic-qr-payload", attempt: 1 });
      }
      break;
    case "ingest-ack":
      send({ type: "state", state: { ...emptyState, lastLiveEventAtMs: message.ok ? 1 : 2 } });
      break;
    case "ping":
      send({ type: "pong", nonce: message.nonce });
      break;
    case "shutdown":
      if (mode !== "ignore-shutdown") {
        process.exit(0);
      }
      break;
    default:
      break;
  }
});
