import type { ArchivePreview } from "@social-explorer/contracts";

/** Minimal Android-shaped export for preview/demo flows (no real phone numbers). */
export const SYNTHETIC_ANDROID_EXPORT = `20/01/2026, 18:00 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.
20/01/2026, 18:05 - Alice Example: Hello from the synthetic sample
20/01/2026, 18:06 - Bob Sample: Thanks!
`;

export function loadSyntheticSample(): { name: string; text: string } {
  return { name: "synthetic-android-private.txt", text: SYNTHETIC_ANDROID_EXPORT };
}

const mockStages = new Map<string, ArchivePreview>();

export function stageSyntheticInMock(sample: { name: string; text: string }): {
  stagedId: string;
  name: string;
  preview: ArchivePreview;
} {
  const stagedId = `mock-${sample.name}`;
  const preview: ArchivePreview = {
    stagedId,
    name: sample.name,
    container: "txt",
    platform: "android",
    conversationCount: 1,
    totalRecords: 3,
    countsByParseStatus: { complete: 2, partial: 0, unparsed: 0 },
    dateRange: { first: "2026-01-20", last: "2026-01-20" },
    conversations: [
      {
        sourceFile: sample.name,
        title: "Alice Example",
        isGroup: false,
        messageCount: 2,
        systemMessageCount: 1,
      },
    ],
    contactCandidates: [
      { displayName: "Alice Example", messageCount: 1 },
      { displayName: "Bob Sample", messageCount: 1 },
    ],
    mediaReferenceCount: 0,
    externalLinkCount: 0,
    confirmation: {
      timezoneCandidates: [{ timezone: "Europe/Rome", source: "hint", recommended: true }],
      selfCandidates: [
        { name: "Alice Example", messageCount: 1, selfEvidence: 1, likelyOther: false, recommended: true },
        { name: "Bob Sample", messageCount: 1, selfEvidence: 0, likelyOther: true, recommended: false },
      ],
      dateOrderReviews: [],
    },
  };
  mockStages.set(stagedId, preview);
  return { stagedId, name: sample.name, preview };
}

export function readMockPreview(stagedId: string): ArchivePreview | undefined {
  return mockStages.get(stagedId);
}