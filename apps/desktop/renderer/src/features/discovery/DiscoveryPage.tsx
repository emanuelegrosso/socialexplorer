import type { GlobalMetrics, GroupSummary } from "@social-explorer/contracts";
import { useCallback, useEffect, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import { DateRangeBar } from "../shared/DateRangeBar";
import { resolveSelection, useDateRangeStore } from "../shared/date-range";
import type { ViewId } from "../../store";

export function DiscoveryPage(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly timezone: string;
  readonly coverageStart?: string | undefined;
  readonly coverageEnd?: string | undefined;
  readonly onNavigate: (view: ViewId) => void;
}) {
  const dateRange = useDateRangeStore();
  const [metrics, setMetrics] = useState<GlobalMetrics | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    const resolved = resolveSelection(dateRange.selection, {
      timezone: props.timezone,
      now: new Date().toISOString(),
      coverageStart: props.coverageStart,
      coverageEnd: props.coverageEnd,
    });
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    setError(null);
    void Promise.all([
      props.client.api.getGlobalAnalytics({
        datasetId: props.datasetId,
        range: resolved.range.analytics,
      }),
      props.client.api.listGroups({ datasetId: props.datasetId }),
    ])
      .then(([global, listedGroups]) => {
        setMetrics(global);
        setGroups([...listedGroups].sort((a, b) => b.messageCount - a.messageCount).slice(0, 6));
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Failed to load discovery summary.");
      });
  }, [
    dateRange.selection,
    props.client.api,
    props.coverageEnd,
    props.coverageStart,
    props.datasetId,
    props.timezone,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="discovery-page">
      <header>
        <h2>Discovery</h2>
        <p className="muted">Activity patterns and social universe entry points — shared filters with Timeline.</p>
        <DateRangeBar
          choice={dateRange.selection.choice}
          customStart={dateRange.selection.customStartDate}
          customEnd={dateRange.selection.customEndDate}
          onChoice={dateRange.setChoice}
          onCustom={dateRange.setCustom}
        />
      </header>
      {error !== null ? <p className="error">{error}</p> : null}
      {metrics === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="discovery-grid">
          <section className="card metric">
            <h3>Activity</h3>
            <dl>
              <div>
                <dt>Messages</dt>
                <dd>{metrics.totalMessages}</dd>
              </div>
              <div>
                <dt>Contacts</dt>
                <dd>{metrics.contactCount}</dd>
              </div>
              <div>
                <dt>Groups</dt>
                <dd>{metrics.groupCount}</dd>
              </div>
              <div>
                <dt>Daily average</dt>
                <dd>{metrics.dailyAverage.toFixed(1)}</dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => {
                props.onNavigate("timeline");
              }}
            >
              Open Temporal Flow
            </button>
          </section>
          <section className="card">
            <h3>Top groups</h3>
            <ul className="plain-list">
              {groups.map((group) => (
                <li key={group.conversationId}>
                  <strong>{group.title}</strong>
                  <span className="muted"> {group.messageCount} messages</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h3>Peaks (statistical)</h3>
            <p>
              Busiest hour:{" "}
              {metrics.peakHour === null ? "—" : `${String(metrics.peakHour).padStart(2, "0")}:00`} · Peak
              weekday: {metrics.peakWeekday === null ? "—" : metrics.peakWeekday}
            </p>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                props.onNavigate("analytics");
              }}
            >
              Full analytics
            </button>
          </section>
        </div>
      )}
    </div>
  );
}