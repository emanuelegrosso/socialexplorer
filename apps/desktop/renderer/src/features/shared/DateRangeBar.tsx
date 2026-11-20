import { RANGE_CHOICES, type RangeChoice } from "./date-range";

export function DateRangeBar(props: {
  readonly choice: RangeChoice;
  readonly customStart?: string | undefined;
  readonly customEnd?: string | undefined;
  readonly onChoice: (choice: RangeChoice) => void;
  readonly onCustom: (start: string, end: string) => void;
}) {
  return (
    <div className="range-bar" aria-label="Date range">
      {RANGE_CHOICES.map((item) => (
        <button
          key={item.id}
          type="button"
          data-active={props.choice === item.id}
          onClick={() => {
            props.onChoice(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
      {props.choice === "custom" ? (
        <label className="range-custom">
          <span>From</span>
          <input
            type="date"
            value={props.customStart ?? ""}
            onChange={(event) => {
              props.onCustom(event.target.value, props.customEnd ?? event.target.value);
            }}
          />
          <span>To</span>
          <input
            type="date"
            value={props.customEnd ?? ""}
            onChange={(event) => {
              props.onCustom(props.customStart ?? event.target.value, event.target.value);
            }}
          />
        </label>
      ) : null}
    </div>
  );
}