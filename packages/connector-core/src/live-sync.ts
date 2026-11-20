import type { PortEvent } from "@social-explorer/baileys-adapter";
import { DraftBuilder } from "./draft-builder.js";
import type { CanonicalMapper } from "./mapper.js";
import { emptyDraft, type SyncState } from "./sync-state.js";

type EventOf<N extends PortEvent["name"]> = Extract<PortEvent, { name: N }>["data"];

/** Processes live, read-only events: upserts, chat/contact/group updates, edits, deletes, reactions. */
export class LiveSyncProcessor {
  constructor(
    private readonly mapper: CanonicalMapper,
    private readonly state: SyncState,
  ) {}

  async handle(event: PortEvent): Promise<boolean> {
    switch (event.name) {
      case "messages.upsert":
        await this.commit(new DraftBuilder(this.mapper, "baileys-live").addMessages(event.data.messages));
        return true;
      case "chats.upsert":
      case "chats.update":
        await this.commit(new DraftBuilder(this.mapper, "baileys-live").addChats(event.data));
        return true;
      case "contacts.upsert":
      case "contacts.update":
        await this.commit(new DraftBuilder(this.mapper, "baileys-live").addContacts(event.data));
        return true;
      case "groups.upsert":
      case "groups.update":
        await this.commit(new DraftBuilder(this.mapper, "baileys-live").addGroups(event.data));
        return true;
      case "lid-mapping.update":
        await this.commit(
          new DraftBuilder(this.mapper, "baileys-live").addContacts([
            { id: event.data.pn, phoneNumberJid: event.data.pn, lid: event.data.lid },
          ]),
        );
        return true;
      case "messages.update":
        await this.handleUpdates(event.data);
        return true;
      case "messages.delete":
        await this.handleDelete(event.data);
        return true;
      case "messages.reaction":
        await this.handleReactions(event.data);
        return true;
      case "chats.delete":
        await this.commit({
          ...emptyDraft("baileys-live"),
          deletedConversationIds: event.data.map((jid) => this.mapper.conversationId(jid)),
        });
        return true;
      default:
        return false;
    }
  }

  private async commit(input: DraftBuilder | ReturnType<typeof emptyDraft>): Promise<void> {
    await this.state.commit(input instanceof DraftBuilder ? input.draft : input);
  }

  private async handleUpdates(updates: EventOf<"messages.update">): Promise<void> {
    const draft = emptyDraft("baileys-live");
    for (const update of updates) {
      const messageId = this.mapper.messageId(update.key.remoteJid, update.key.id);
      if (update.revoked === true) {
        draft.deletedMessageIds.push(messageId);
      } else if (update.editedText !== undefined) {
        draft.edits.push({
          messageId,
          text: update.editedText,
          ...(update.editedAtMs === undefined ? {} : { editedAtMs: update.editedAtMs }),
        });
      }
    }
    await this.state.commit(draft);
  }

  private async handleDelete(data: EventOf<"messages.delete">): Promise<void> {
    const draft = emptyDraft("baileys-live");
    if ("keys" in data) {
      draft.deletedMessageIds = data.keys.map((key) => this.mapper.messageId(key.remoteJid, key.id));
    } else {
      draft.deletedConversationIds = [this.mapper.conversationId(data.jid)];
    }
    await this.state.commit(draft);
  }

  private async handleReactions(reactions: EventOf<"messages.reaction">): Promise<void> {
    const draft = emptyDraft("baileys-live");
    for (const entry of reactions) {
      const mapped = this.mapper.mapReaction(entry);
      if (mapped.reaction !== undefined) {
        draft.reactions.push(mapped.reaction);
      }
      if (mapped.removedId !== undefined) {
        draft.removedReactionIds.push(mapped.removedId);
      }
    }
    await this.state.commit(draft);
  }
}
