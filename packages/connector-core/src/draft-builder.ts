import type {
  PortChat,
  PortContact,
  PortGroup,
  PortMessage,
} from "@social-explorer/baileys-adapter";
import type { CanonicalMapper } from "./mapper.js";
import { emptyDraft, type BatchDraft } from "./sync-state.js";

export class DraftBuilder {
  readonly draft: BatchDraft;

  constructor(
    private readonly mapper: CanonicalMapper,
    source: BatchDraft["source"],
  ) {
    this.draft = emptyDraft(source);
  }

  addChats(chats: readonly PortChat[]): this {
    for (const chat of chats) {
      this.draft.conversations.push(this.mapper.mapChat(chat));
    }
    return this;
  }

  addContacts(contacts: readonly PortContact[]): this {
    for (const contact of contacts) {
      this.draft.contacts.push(this.mapper.mapContact(contact));
      this.mapper.rememberChatName(contact.id, contact.name ?? contact.notify);
    }
    return this;
  }

  addGroups(groups: readonly PortGroup[]): this {
    for (const group of groups) {
      const mapped = this.mapper.mapGroup(group);
      this.draft.conversations.push(mapped.conversation);
      this.draft.contacts.push(...mapped.contacts);
      this.draft.participants.push(...mapped.participants);
    }
    return this;
  }

  addMessages(messages: readonly PortMessage[]): this {
    const source = this.draft.source;
    for (const message of messages) {
      const mapped = this.mapper.mapMessage(message, source);
      this.draft.messages.push(mapped.message);
      this.draft.conversations.push(mapped.conversation);
      if (mapped.contact !== undefined) {
        this.draft.contacts.push(mapped.contact);
      }
      if (mapped.participant !== undefined) {
        this.draft.participants.push(mapped.participant);
      }
    }
    return this;
  }
}
