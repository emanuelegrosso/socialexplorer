import type { ContactSummary, GroupMetrics, GroupSummary } from "@social-explorer/contracts";
import type { RendererIpcClient } from "../../ipc-client";
import type { PanelTarget } from "./selection";

export function SelectionPanel(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly target: PanelTarget;
  readonly participantId?: string | undefined;
  readonly groups: readonly GroupSummary[];
  readonly contacts: readonly ContactSummary[];
  readonly groupMetrics: GroupMetrics | null;
  readonly onSelectParticipant: (contactId: string | undefined) => void;
  readonly onRefresh: () => void;
}) {
  if (props.target.kind === "none" || props.target.entityId === undefined) {
    return (
      <aside className="side-panel" aria-label="Selection details">
        <p className="muted">Select a contact or group in the flow to inspect connections.</p>
      </aside>
    );
  }
  if (props.target.kind === "contact") {
    const contact = props.contacts.find((item) => item.id === props.target.entityId);
    const mergeCandidates = props.contacts.filter(
      (item) => item.id !== props.target.entityId && contact !== undefined,
    );
    return (
      <aside className="side-panel" aria-label="Selection details">
        <h2>{contact?.displayName ?? props.target.entityId}</h2>
        <p className="muted">Contact lane</p>
        <MergeControls
          client={props.client}
          datasetId={props.datasetId}
          primaryId={props.target.entityId}
          candidates={mergeCandidates}
          onRefresh={props.onRefresh}
        />
      </aside>
    );
  }
  const group = props.groups.find((item) => item.conversationId === props.target.entityId);
  const metrics = props.groupMetrics;
  return (
    <aside className="side-panel" aria-label="Selection details">
      <h2>{group?.title ?? "Group"}</h2>
      <p className="muted">{group?.messageCount ?? 0} messages in dataset</p>
      <h3>Participants</h3>
      <ul className="participant-list">
        {(metrics?.participants ?? []).map((participant) => (
          <li key={participant.contactId ?? participant.displayName}>
            <button
              type="button"
              data-active={props.participantId === participant.contactId}
              onClick={() => {
                props.onSelectParticipant(participant.contactId ?? undefined);
              }}
            >
              {participant.displayName} ({participant.messageCount})
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function MergeControls(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly primaryId: string;
  readonly candidates: readonly ContactSummary[];
  readonly onRefresh: () => void;
}) {
  return (
    <section className="merge-box">
      <h3>Contact identity</h3>
      <label>
        Merge with
        <select id="merge-secondary" defaultValue="">
          <option value="">Choose contact…</option>
          {props.candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <button
          type="button"
          onClick={() => {
            const select = document.getElementById("merge-secondary") as HTMLSelectElement | null;
            const secondary = select?.value;
            if (secondary === undefined || secondary === "") {
              return;
            }
            void props.client.api
              .mergeContacts({
                datasetId: props.datasetId,
                primaryContactId: props.primaryId,
                secondaryContactId: secondary,
              })
              .then(() => {
                props.onRefresh();
              });
          }}
        >
          Merge
        </button>
        <button
          type="button"
          onClick={() => {
            void props.client.api.unmergeContact({ datasetId: props.datasetId, secondaryContactId: props.primaryId }).then(() => {
              props.onRefresh();
            });
          }}
        >
          Unmerge
        </button>
      </div>
    </section>
  );
}