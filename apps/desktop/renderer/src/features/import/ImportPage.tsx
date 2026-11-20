import type {
  ArchiveCommitResult,
  ArchiveConfirmResult,
  ArchivePreview,
  IpcRequest,
} from "@social-explorer/contracts";
import { useEffect, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import { useUiStore } from "../../store";
import { readResumableImport, writeResumableImport } from "./resumable";
import { loadSyntheticSample, stageSyntheticInMock } from "./synthetic-sample";

type Step = "pick" | "preview" | "confirm" | "review" | "committing" | "done";

export function ImportPage(props: { readonly client: RendererIpcClient }) {
  const setActiveDataset = useUiStore((state) => state.setActiveDataset);
  const [step, setStep] = useState<Step>("pick");
  const [stagedId, setStagedId] = useState<string | undefined>(undefined);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [confirm, setConfirm] = useState<ArchiveConfirmResult | null>(null);
  const [timezone, setTimezone] = useState("Europe/Rome");
  const [selfName, setSelfName] = useState("");
  const [resolutions, setResolutions] = useState<IpcRequest<"archive-import:commit">["resolutions"]>({});
  const [progress, setProgress] = useState<ArchiveCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState(readResumableImport());

  useEffect(() => {
    setResumable(readResumableImport());
  }, []);

  const reset = (): void => {
    setStep("pick");
    setStagedId(undefined);
    setFileName(undefined);
    setPreview(null);
    setConfirm(null);
    setProgress(null);
    setResolutions({});
    setError(null);
  };

  const pickFile = (): void => {
    setError(null);
    void props.client.api.pickArchiveFile().then((picked) => {
      if (picked.canceled || picked.stagedId === undefined) {
        return;
      }
      setStagedId(picked.stagedId);
      setFileName(picked.name);
      return props.client.api.previewArchive({ stagedId: picked.stagedId }).then((next) => {
        setPreview(next);
        const recommendedTz = next.confirmation.timezoneCandidates.find((item) => item.recommended);
        if (recommendedTz !== undefined) {
          setTimezone(recommendedTz.timezone);
        }
        const recommendedSelf = next.confirmation.selfCandidates.find((item) => item.recommended);
        if (recommendedSelf !== undefined) {
          setSelfName(recommendedSelf.name);
        }
        setStep("preview");
      });
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Import failed.");
    });
  };

  const loadSample = (): void => {
    setError(null);
    if (!props.client.isNative) {
      const staged = stageSyntheticInMock(loadSyntheticSample());
      setStagedId(staged.stagedId);
      setFileName(staged.name);
      setPreview(staged.preview);
      setTimezone("Europe/Rome");
      setSelfName("Alice Example");
      setStep("preview");
      return;
    }
    void props.client.api
      .stageFixture({ file: "android-private" })
      .then((picked) => {
        if (picked.canceled || picked.stagedId === undefined) {
          return;
        }
        setStagedId(picked.stagedId);
        setFileName(picked.name);
        return props.client.api.previewArchive({ stagedId: picked.stagedId }).then((next) => {
          setPreview(next);
          const recommendedTz = next.confirmation.timezoneCandidates.find((item) => item.recommended);
          if (recommendedTz !== undefined) {
            setTimezone(recommendedTz.timezone);
          }
          const recommendedSelf = next.confirmation.selfCandidates.find((item) => item.recommended);
          if (recommendedSelf !== undefined) {
            setSelfName(recommendedSelf.name);
          }
          setStep("preview");
        });
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load synthetic sample.");
      });
  };

  const runConfirm = (): void => {
    if (stagedId === undefined) {
      return;
    }
    void props.client.api
      .confirmArchive({ stagedId, timezone, selfNames: selfName === "" ? [] : [selfName] })
      .then((result) => {
        setConfirm(result);
        setStep("review");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Confirmation failed.");
      });
  };

  const runCommit = (): void => {
    if (stagedId === undefined) {
      return;
    }
    setStep("committing");
    void props.client.api
      .commitArchive({ stagedId, resolutions })
      .then((result) => {
        setProgress(result);
        if (result.status === "failed" && result.resumedFromChunk < result.totalChunks) {
          writeResumableImport({
            datasetId: result.datasetId,
            datasetName: fileName ?? result.datasetId,
            stagedId,
            resumedFromChunk: result.resumedFromChunk,
            totalChunks: result.totalChunks,
          });
          setResumable(readResumableImport());
        } else {
          writeResumableImport(undefined);
          setResumable(undefined);
        }
        if (result.status === "committed") {
          setActiveDataset(result.datasetId);
          setStep("done");
        } else if (result.status === "failed") {
          setError("Import failed before completion. You can resume when the staged archive is still available.");
          setStep("review");
        }
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Commit failed.");
        setStep("review");
      });
  };

  const cancel = (): void => {
    if (stagedId !== undefined) {
      void props.client.api.cancelArchive({ stagedId });
    }
    reset();
  };

  return (
    <div className="import-page">
      {resumable !== undefined ? (
        <div className="banner resumable-banner" role="status">
          Interrupted import for {resumable.datasetName}: chunk {resumable.resumedFromChunk} of{" "}
          {resumable.totalChunks}. Re-open Import and commit again when the same archive is staged.
        </div>
      ) : null}
      {step === "pick" ? (
        <section>
          <p>Select a WhatsApp `.txt` or `.zip` export. Parsing stays on the desktop main process.</p>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                pickFile();
              }}
            >
              Choose file
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                loadSample();
              }}
            >
              Load synthetic sample
            </button>
          </div>
        </section>
      ) : null}
      {preview !== null && step === "preview" ? (
        <section className="card wide">
          <h2>{fileName ?? preview.name}</h2>
          <dl>
            <dt>Format</dt>
            <dd>
              {preview.platform} / {preview.container}
            </dd>
            <dt>Conversations</dt>
            <dd>{preview.conversationCount}</dd>
            <dt>Records</dt>
            <dd>{preview.totalRecords}</dd>
          </dl>
          <label>
            Time zone
            <select
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
              }}
            >
              {preview.confirmation.timezoneCandidates.map((item) => (
                <option key={item.timezone} value={item.timezone}>
                  {item.timezone} ({item.source})
                </option>
              ))}
            </select>
          </label>
          <label>
            Self participant
            <select
              value={selfName}
              onChange={(event) => {
                setSelfName(event.target.value);
              }}
            >
              <option value="">Unknown</option>
              {preview.confirmation.selfCandidates.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                setStep("confirm");
              }}
            >
              Continue
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                cancel();
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      {step === "confirm" && preview !== null ? (
        <section className="card wide">
          <p>Confirm time zone <strong>{timezone}</strong> and self <strong>{selfName || "unknown"}</strong>.</p>
          <button
            type="button"
            onClick={() => {
              runConfirm();
            }}
          >
            Build merge plan
          </button>
        </section>
      ) : null}
      {confirm !== null && step === "review" ? (
        <section className="card wide">
          <h2>Merge plan</h2>
          <p>
            new {confirm.counts.new} · exact duplicates {confirm.counts.exactDuplicate} · ambiguous{" "}
            {confirm.counts.ambiguous}
          </p>
          <ul>
            {confirm.contacts.map((contact) => (
              <li key={contact.displayName}>
                {contact.displayName} — {contact.status}
              </li>
            ))}
          </ul>
          {confirm.reviews.map((item) => (
            <label key={item.reviewId}>
              {item.summary}
              <select
                value={resolutions[item.reviewId]?.action ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setResolutions((state: IpcRequest<"archive-import:commit">["resolutions"]) => {
                    const next = { ...state };
                    if (value === "keep_both") {
                      next[item.reviewId] = { action: "keep_both" };
                    } else if (value === "skip_incoming") {
                      next[item.reviewId] = { action: "skip_incoming" };
                    } else if (value.startsWith("link:")) {
                      next[item.reviewId] = {
                        action: "link_existing",
                        existingId: value.slice("link:".length),
                      };
                    }
                    return next;
                  });
                }}
              >
                <option value="">Choose…</option>
                <option value="keep_both">Keep both</option>
                <option value="skip_incoming">Skip incoming</option>
                {item.candidates.map((candidate) => (
                  <option key={candidate.id} value={`link:${candidate.id}`}>
                    Link {candidate.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                runCommit();
              }}
            >
              Commit import
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                cancel();
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      {step === "committing" ? <p>Committing chunks…</p> : null}
      {progress !== null && step === "done" ? (
        <section className="card wide">
          <p>Committed {progress.persisted.messagesInserted} messages to dataset {progress.datasetId}.</p>
          <button
            type="button"
            onClick={() => {
              reset();
            }}
          >
            Import another
          </button>
        </section>
      ) : null}
      {error !== null ? <p className="error">{error}</p> : null}
    </div>
  );
}