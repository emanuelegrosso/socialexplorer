import { fnv1a64Hex } from "@social-explorer/shared";

export const GROUP_NEUTRAL_COLOR = "#8FA6BC";
export const PALETTE_SIZE = 24;

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number): number => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): string => {
    const value = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/** Saturated hues on a dark navy background; avoids the desaturated group blue-gray. */
export const CONTACT_PALETTE: readonly string[] = Array.from({ length: PALETTE_SIZE }, (_, slot) => {
  const hue = ((slot * 7) % PALETTE_SIZE) * (360 / PALETTE_SIZE);
  return hslToHex(hue, 78, slot % 2 === 0 ? 62 : 72);
});

export function paletteIndex(entityId: string): number {
  return Number.parseInt(fnv1a64Hex(entityId).slice(0, 8), 16) % PALETTE_SIZE;
}

/** Deterministic, id-derived and therefore independent of date range or contact ordering. */
export function contactColor(contactId: string): string {
  return CONTACT_PALETTE[paletteIndex(contactId)] ?? GROUP_NEUTRAL_COLOR;
}

export function contactColorKey(contactId: string): string {
  return `palette-${String(paletteIndex(contactId))}`;
}

export function colorForColorKey(colorKey: string, fallbackId: string): string {
  const match = /^palette-(\d+)$/u.exec(colorKey);
  const index = match?.[1] === undefined ? undefined : Number(match[1]);
  const color = index === undefined ? undefined : CONTACT_PALETTE[index];
  return color ?? contactColor(fallbackId);
}
