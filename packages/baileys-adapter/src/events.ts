/**
 * Normalized, read-only event model produced by the adapter. It deliberately carries no protobuf
 * objects, media bytes or write capabilities: only the metadata the connector needs for ingestion.
 */

export type PortMessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "link"
  | "system"
  | "call"
  | "unknown";

export interface PortMessageKey {
  readonly remoteJid: string;
  readonly id: string;
  readonly fromMe: boolean;
  readonly participant?: string;
}

export interface PortMessage {
  readonly key: PortMessageKey;
  readonly timestampMs: number;
  readonly kind: PortMessageKind;
  readonly text?: string;
  readonly hasAttachment: boolean;
  readonly pushName?: string;
}

export interface PortChat {
  readonly id: string;
  readonly name?: string;
}

export interface PortContact {
  readonly id: string;
  readonly lid?: string;
  readonly phoneNumberJid?: string;
  readonly name?: string;
  readonly notify?: string;
}

export interface PortGroup {
  readonly id: string;
  readonly subject?: string;
  readonly participantIds?: readonly string[];
}

export interface PortConnectionUpdate {
  readonly connection?: "open" | "connecting" | "close";
  readonly qr?: string;
  readonly isNewLogin?: boolean;
  readonly receivedPendingNotifications?: boolean;
  /** Present when the connection closed with an error. Message text is never forwarded to logs. */
  readonly disconnect?: { readonly statusCode?: number; readonly message?: string };
}

export interface PortHistorySet {
  readonly chats: readonly PortChat[];
  readonly contacts: readonly PortContact[];
  readonly messages: readonly PortMessage[];
  readonly isLatest?: boolean;
  readonly progress?: number | null;
  readonly syncType?: number | null;
  readonly chunkOrder?: number | null;
}

export interface PortHistoryStatus {
  readonly syncType: number;
  readonly status: "complete" | "paused";
  /** false means completion was inferred from a timeout: coverage must be treated as partial. */
  readonly explicit: boolean;
}

export interface PortMessageUpdate {
  readonly key: PortMessageKey;
  readonly editedText?: string;
  readonly editedAtMs?: number;
  readonly revoked?: boolean;
}

export interface PortReaction {
  readonly key: PortMessageKey;
  readonly reactorId?: string;
  /** Empty string means the reaction was removed. */
  readonly emoji: string;
  readonly timestampMs?: number;
}

export type PortMessageDelete =
  | { readonly keys: readonly PortMessageKey[] }
  | { readonly jid: string; readonly all: true };

export type PortEvent =
  | { readonly name: "connection.update"; readonly data: PortConnectionUpdate }
  | { readonly name: "creds.update"; readonly data: Readonly<Record<string, unknown>> }
  | { readonly name: "history.set"; readonly data: PortHistorySet }
  | { readonly name: "history.status"; readonly data: PortHistoryStatus }
  | {
      readonly name: "messages.upsert";
      readonly data: { readonly type: "append" | "notify"; readonly messages: readonly PortMessage[] };
    }
  | { readonly name: "messages.update"; readonly data: readonly PortMessageUpdate[] }
  | { readonly name: "messages.delete"; readonly data: PortMessageDelete }
  | { readonly name: "messages.reaction"; readonly data: readonly PortReaction[] }
  | { readonly name: "chats.upsert"; readonly data: readonly PortChat[] }
  | { readonly name: "chats.update"; readonly data: readonly PortChat[] }
  | { readonly name: "chats.delete"; readonly data: readonly string[] }
  | { readonly name: "contacts.upsert"; readonly data: readonly PortContact[] }
  | { readonly name: "contacts.update"; readonly data: readonly PortContact[] }
  | { readonly name: "groups.upsert"; readonly data: readonly PortGroup[] }
  | { readonly name: "groups.update"; readonly data: readonly PortGroup[] }
  | {
      readonly name: "lid-mapping.update";
      readonly data: { readonly lid: string; readonly pn: string };
    };

export type PortEventName = PortEvent["name"];
