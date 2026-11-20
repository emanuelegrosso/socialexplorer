import type { ContactSummary, GroupMetrics, GroupSummary, TemporalFlowReadModel } from "@social-explorer/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import { DateRangeBar } from "../shared/DateRangeBar";
import { resolveSelection, useDateRangeStore } from "../shared/date-range";
import { ENTITY_FILTERS, type EntityFilter, searchEntities } from "./filters";
import { buildSceneFrame } from "./frame";
import type { CanvasController } from "./canvas-host";
import { buildOverlayLabels } from "./labels";
import { buildLaneRegistry, worldBounds } from "./layout";
import {
  clearSelection,
  highlightParticipant,
  panelTarget,
  selectEntity,
  toggleIsolation,
  type SelectionState,
} from "./selection";
import {
  createPlayback,
  formatTimestamp,
  pause,
  play,
  playbackStops,
  rebase,
  setMode,
  setSpeed,
  seek,
  stepBack,
  stepForward,
  tick,
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
  type ViewMode,
} from "./playback";
import { TemporalScene } from "./TemporalScene";
import { SelectionPanel } from "./SelectionPanel";

export function TemporalPage(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly timezone: string;
  readonly coverageStart?: string | undefined;
  readonly coverageEnd?: string | undefined;
}) {
  const dateRange = useDateRangeStore();
  const [model, setModel] = useState<TemporalFlowReadModel | null>(null);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupMetrics, setGroupMetrics] = useState<GroupMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>(clearSelection());
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [search, setSearch] = useState("");
  const [zoom, setZoom] = useState(1);
  const [mode, setViewMode] = useState<ViewMode>("static");
  const [playback, setPlayback] = useState(() => createPlayback(0, 1));
  const [reducedMotion, setReducedMotion] = useState(false);
  const controllerRef = useRef<CanvasController | null>(null);
  const registryRef = useRef(buildLaneRegistry({ lanes: [], layoutVersion: 1 }));

  const rangeResolution = useMemo(
    () =>
      resolveSelection(dateRange.selection, {
        timezone: props.timezone,
        now: new Date().toISOString(),
        coverageStart: props.coverageStart,
        coverageEnd: props.coverageEnd,
      }),
    [dateRange.selection, props.coverageEnd, props.coverageStart, props.timezone],
  );

  const reload = useCallback((): void => {
    if (!rangeResolution.ok) {
      setError(rangeResolution.error);
      return;
    }
    setError(null);
    const { range } = rangeResolution;
    void Promise.all([
      props.client.api.getTemporalReadModel({
        datasetId: props.datasetId,
        preset: range.temporal.preset,
        start: range.temporal.start,
        end: range.temporal.end,
      }),
      props.client.api.listContacts({ datasetId: props.datasetId }),
      props.client.api.listGroups({ datasetId: props.datasetId }),
    ])
      .then(([next, listedContacts, listedGroups]) => {
        setModel(next);
        setContacts(listedContacts);
        setGroups(listedGroups);
        registryRef.current = buildLaneRegistry(next, registryRef.current);
        setPlayback((state) => rebase({ ...state, reducedMotion }, range.startMs, range.endMs));
        const frame = buildSceneFrame(next, {
          registry: registryRef.current,
          zoom: 1,
          mode: "static",
          cursorMs: range.startMs,
          selection: clearSelection(),
          entityFilter: "all",
          reducedMotion,
        });
        controllerRef.current?.core.setBounds(worldBounds(registryRef.current, frame.axis.height));
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Failed to load temporal model.");
      });
  }, [props.client.api, props.datasetId, rangeResolution, reducedMotion]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const panel = panelTarget(selection, registryRef.current.lanes);
    if (panel.kind !== "group" || panel.entityId === undefined || !rangeResolution.ok) {
      setGroupMetrics(null);
      return;
    }
    void props.client.api
      .getGroupAnalytics({
        datasetId: props.datasetId,
        conversationId: panel.entityId,
        range: rangeResolution.range.analytics,
      })
      .then(setGroupMetrics)
      .catch(() => {
        setGroupMetrics(null);
      });
  }, [props.client.api, props.datasetId, rangeResolution, selection]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (): void => {
      setReducedMotion(query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => {
      query.removeEventListener("change", apply);
    };
  }, []);

  useEffect(() => {
    if (!playback.playing || model === null) {
      return;
    }
    const stops = playbackStops(model);
    let frame = 0;
    let last = performance.now();
    const loop = (now: number): void => {
      const delta = now - last;
      last = now;
      setPlayback((state) => tick(state, delta, stops));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [model, playback.playing, reducedMotion]);

  const aliases = useMemo(
    () => new Map(contacts.map((contact) => [contact.id, contact.aliases] as const)),
    [contacts],
  );

  const frame =
    model === null
      ? null
      : buildSceneFrame(model, {
          registry: registryRef.current,
          zoom,
          mode,
          cursorMs: playback.cursorMs,
          selection,
          entityFilter,
          reducedMotion,
        });

  const labels = model !== null && frame !== null ? buildOverlayLabels(model, registryRef.current, frame, selection) : [];
  const hits = searchEntities(registryRef.current.lanes.values(), aliases, search, entityFilter);

  const onSearchPick = (entityId: string): void => {
    const lane = registryRef.current.lanes.get(entityId);
    if (lane === undefined || frame === null) {
      return;
    }
    controllerRef.current?.focusOn(lane.x, frame.axis.height / 2);
    controllerRef.current?.zoomBy(1.4);
    setSelection(selectEntity(clearSelection(), entityId));
  };

  return (
    <div className="temporal-page">
      <header className="temporal-toolbar">
        <DateRangeBar
          choice={dateRange.selection.choice}
          customStart={dateRange.selection.customStartDate}
          customEnd={dateRange.selection.customEndDate}
          onChoice={dateRange.setChoice}
          onCustom={dateRange.setCustom}
        />
        <label className="search-field">
          Search
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Names or aliases"
          />
        </label>
        <div className="filter-row">
          {ENTITY_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              data-active={entityFilter === filter.id}
              onClick={() => {
                setEntityFilter(filter.id);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="playback-row">
          <button
            type="button"
            data-active={mode === "static"}
            onClick={() => {
              setViewMode("static");
              setPlayback((state) => setMode(state, "static"));
            }}
          >
            Static
          </button>
          <button
            type="button"
            data-active={mode === "playback"}
            onClick={() => {
              setViewMode("playback");
              setPlayback((state) => setMode(state, "playback"));
            }}
          >
            Playback
          </button>
          <button
            type="button"
            disabled={mode !== "playback"}
            onClick={() => {
              setPlayback((state) => (state.playing ? pause(state) : play(state)));
            }}
          >
            {playback.playing ? "Pause" : "Play"}
          </button>
          {PLAYBACK_SPEEDS.map((speed: PlaybackSpeed) => (
            <button
              key={speed}
              type="button"
              data-active={playback.speed === speed}
              disabled={mode !== "playback"}
              onClick={() => {
                setPlayback((state) => setSpeed(state, speed));
              }}
            >
              {speed}x
            </button>
          ))}
          <button
            type="button"
            disabled={model === null || mode !== "playback"}
            onClick={() => {
              if (model === null) {
                return;
              }
              setPlayback((state) => stepBack(state, playbackStops(model)));
            }}
          >
            Step back
          </button>
          <button
            type="button"
            disabled={model === null || mode !== "playback"}
            onClick={() => {
              if (model === null) {
                return;
              }
              setPlayback((state) => stepForward(state, playbackStops(model)));
            }}
          >
            Step forward
          </button>
          <button
            type="button"
            onClick={() => {
              controllerRef.current?.resetView();
            }}
          >
            Reset view
          </button>
        </div>
        {mode === "playback" ? (
          <div className="scrubber">
            <input
              type="range"
              min={playback.startMs}
              max={playback.endMs}
              value={playback.cursorMs}
              onChange={(event) => {
                setPlayback((state) => seek(state, Number(event.target.value)));
              }}
            />
            <span className="hud">{formatTimestamp(playback.cursorMs, props.timezone)}</span>
          </div>
        ) : null}
        {hits.length > 0 ? (
          <ul className="search-hits">
            {hits.map((hit) => (
              <li key={hit.entityId}>
                <button
                  type="button"
                  onClick={() => {
                    onSearchPick(hit.entityId);
                  }}
                >
                  {hit.label} ({hit.matchedOn}: {hit.matchedText})
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error !== null ? <p className="error">{error}</p> : null}
        {model?.coverage.warnings.map((warning) => (
          <p key={warning} className="warning">
            {warning}
          </p>
        ))}
      </header>
      <div className="temporal-body">
        {frame === null ? (
          <p className="muted">Loading temporal flow…</p>
        ) : (
          <TemporalScene
            frame={frame}
            labels={labels}
            reducedMotion={reducedMotion}
            onSelect={(entityId) => {
              setSelection(entityId === undefined ? clearSelection() : selectEntity(clearSelection(), entityId));
            }}
            onZoom={setZoom}
            onReady={(controller) => {
              controllerRef.current = controller;
            }}
          />
        )}
        <SelectionPanel
          client={props.client}
          datasetId={props.datasetId}
          target={panelTarget(selection, registryRef.current.lanes)}
          participantId={selection.participantId}
          groups={groups}
          contacts={contacts}
          groupMetrics={groupMetrics}
          onSelectParticipant={(participantId) => {
            setSelection((state) => highlightParticipant(state, participantId));
          }}
          onRefresh={reload}
        />
      </div>
      {selection.entityId !== undefined ? (
        <footer className="selection-bar">
          <span>Selected {registryRef.current.lanes.get(selection.entityId)?.label ?? selection.entityId}</span>
          <button
            type="button"
            onClick={() => {
              setSelection((state) => toggleIsolation(state));
            }}
          >
            {selection.mode === "isolated" ? "Exit isolation" : "Isolate"}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelection(clearSelection());
            }}
          >
            Clear
          </button>
        </footer>
      ) : null}
    </div>
  );
}