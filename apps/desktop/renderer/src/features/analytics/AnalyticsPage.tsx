import type { GlobalMetrics } from "@social-explorer/contracts";
import { useCallback, useEffect, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import { DateRangeBar } from "../shared/DateRangeBar";
import { resolveSelection, useDateRangeStore } from "../shared/date-range";

export function AnalyticsPage(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly timezone: string;
  readonly coverageStart?: string | undefined;
  readonly coverageEnd?: string | undefined;
}) {
  const dateRange = useDateRangeStore();
  const [metrics, setMetrics] = useState<GlobalMetrics | null>(null);
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
    void props.client.api
      .getGlobalAnalytics({ datasetId: props.datasetId, range: resolved.range.analytics })
      .then(setMetrics)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Failed to load analytics.");
      });
  }, [dateRange.selection, props.client.api, props.coverageEnd, props.coverageStart, props.datasetId, props.timezone]);

  useEffect(() => {
    load();
  }, [load]);

  const busyHour = metrics === null || metrics.peakHour === null ? 0 : metrics.peakHour;
  const maxHour = Math.max(...(metrics?.hourly ?? [1]), 1);

  return (
    <div className="analytics-page">
      <header>
        <h2>Analytics</h2>
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
        <p className="muted">Loading metrics…</p>
      ) : (
        <>
          <section className="metrics-grid">
            <MetricCard label="Total messages" value={String(metrics.totalMessages)} />
            <MetricCard label="Contacts" value={String(metrics.contactCount)} />
            <MetricCard label="Groups" value={String(metrics.groupCount)} />
            <MetricCard label="Daily average" value={metrics.dailyAverage.toFixed(2)} />
          </section>
          <section className="chart-block">
            <h3>Busiest days</h3>
            <BarChart
              items={metrics.busiestDays.map((day) => ({ label: day.date, value: day.count }))}
            />
          </section>
          <section className="chart-block">
            <h3>Busiest hours</h3>
            <BarChart
              items={metrics.hourly.map((count, hour) => ({
                label: `${String(hour).padStart(2, "0")}:00`,
                value: count,
                active: hour === busyHour,
              }))}
              max={maxHour}
            />
          </section>
          <section className="chart-block">
            <h3>Top contacts</h3>
            <TopContacts metrics={metrics} client={props.client} datasetId={props.datasetId} />
          </section>
          <section className="chart-block">
            <h3>Top groups</h3>
            <TopGroups metrics={metrics} client={props.client} datasetId={props.datasetId} />
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard(props: { readonly label: string; readonly value: string }) {
  return (
    <article className="metric-card">
      <p className="muted">{props.label}</p>
      <strong>{props.value}</strong>
    </article>
  );
}

function BarChart(props: {
  readonly items: readonly { readonly label: string; readonly value: number; readonly active?: boolean }[];
  readonly max?: number;
}) {
  const max = props.max ?? Math.max(...props.items.map((item) => item.value), 1);
  return (
    <div className="bar-chart" role="img" aria-label="Bar chart">
      {props.items.map((item) => (
        <div key={item.label} className="bar-row" data-active={item.active === true}>
          <span>{item.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${String((item.value / max) * 100)}%` }} />
          </div>
          <span>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function TopContacts(props: {
  readonly metrics: GlobalMetrics;
  readonly client: RendererIpcClient;
  readonly datasetId: string;
}) {
  const [rows, setRows] = useState<{ name: string; count: number }[]>([]);
  useEffect(() => {
    void props.client.api.listContacts({ datasetId: props.datasetId }).then((contacts) => {
      void Promise.all(
        contacts.slice(0, 5).map((contact) =>
          props.client.api
            .getContactAnalytics({
              datasetId: props.datasetId,
              contactId: contact.id,
              range: props.metrics.range,
            })
            .then((item) => ({ name: item.displayName, count: item.totalMessages })),
        ),
      ).then((loaded) => {
        setRows(loaded.sort((a, b) => b.count - a.count));
      });
    });
  }, [props.client.api, props.datasetId, props.metrics.range]);
  return (
    <ol>
      {rows.map((row) => (
        <li key={row.name}>
          {row.name}: {row.count}
        </li>
      ))}
    </ol>
  );
}

function TopGroups(props: {
  readonly metrics: GlobalMetrics;
  readonly client: RendererIpcClient;
  readonly datasetId: string;
}) {
  const [rows, setRows] = useState<{ name: string; count: number }[]>([]);
  useEffect(() => {
    void props.client.api.listGroups({ datasetId: props.datasetId }).then((groups) => {
      void Promise.all(
        groups.slice(0, 5).map((group) =>
          props.client.api
            .getGroupAnalytics({
              datasetId: props.datasetId,
              conversationId: group.conversationId,
              range: props.metrics.range,
            })
            .then((item) => ({ name: item.title, count: item.totalMessages })),
        ),
      ).then((loaded) => {
        setRows(loaded.sort((a, b) => b.count - a.count));
      });
    });
  }, [props.client.api, props.datasetId, props.metrics.range]);
  return (
    <ol>
      {rows.map((row) => (
        <li key={row.name}>
          {row.name}: {row.count}
        </li>
      ))}
    </ol>
  );
}