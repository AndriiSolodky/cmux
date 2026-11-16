// The New Tab clock (`tabs.newTabClock.*`): a large stylized time over the composer, with the date
// over it, as the iOS 26 Lock Screen draws them, in a font, weight and colour the person picks (Leo,
// 2026-11-16: "idk why you guys couldn't just add an aesthetic time thing like the ios home screen
// whatever customizer"). It sits in the room over the composer (screen.css `.nt-above-room`) and
// never replaces or covers it. Off by default.
import { useEffect, useState } from "react";
import "./clock.css";

export const CLOCK_FONTS = ["system", "rounded", "serif", "mono", "condensed"] as const;
export const CLOCK_WEIGHTS = ["thin", "regular", "bold", "heavy"] as const;
export const CLOCK_COLORS = ["text", "accent", "muted", "glass"] as const;
export type ClockFont = (typeof CLOCK_FONTS)[number];
export type ClockWeight = (typeof CLOCK_WEIGHTS)[number];
export type ClockColor = (typeof CLOCK_COLORS)[number];

/// The clock's look, from the handshake (`newTab.clock`); absent: no clock.
export type NewTabClockStyle = {
  font: ClockFont;
  weight: ClockWeight;
  color: ClockColor;
  /// The date line over the time ("Monday, November 16").
  date: boolean;
};

const pick = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/// Reads `newTab.clock` from the handshake: `{font, weight, color, date}`, or nothing for no clock.
export function readClockStyle(value: unknown): NewTabClockStyle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { font, weight, color, date } = value as Record<string, unknown>;
  return {
    font: pick(CLOCK_FONTS, font, "rounded"),
    weight: pick(CLOCK_WEIGHTS, weight, "bold"),
    color: pick(CLOCK_COLORS, color, "text"),
    date: date !== false,
  };
}

/// The time as the Lock Screen shows it: hours and minutes in the person's locale and 12/24-hour
/// choice, without the AM/PM mark.
export function clockTime(at: Date, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).formatToParts(at);
  return parts
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}

export function clockDate(at: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(at);
}

/// The next minute boundary after `now`, in ms from now: the clock redraws once a minute, on the minute.
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000) || 60_000;
}

type Props = NewTabClockStyle & {
  /// Tests and the gallery hold the time still.
  now?: number;
  locale?: string;
};

export function NewTabClock({ font, weight, color, date, now: fixed, locale }: Props) {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) {
      setNow(fixed);
      return;
    }
    // One timer at a time, to the next minute; it ends with the page (stop condition: unmount).
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = setTimeout(tick, msToNextMinute(at));
    };
    timer = setTimeout(tick, msToNextMinute(Date.now()));
    return () => clearTimeout(timer);
  }, [fixed]);
  const at = new Date(now);
  return (
    <div className="nt-clock" data-font={font} data-weight={weight} data-color={color}>
      {date && <div className="nt-clock-date">{clockDate(at, locale)}</div>}
      <time className="nt-clock-time" dateTime={at.toISOString()}>
        {clockTime(at, locale)}
      </time>
    </div>
  );
}
