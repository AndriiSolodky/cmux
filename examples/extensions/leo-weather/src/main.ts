// Leo weather: the live sky where you are, animated by cmux itself. Rain, snow and stars are
// `Particles`, the sun spins and glows, clouds float, the sky's gradient follows the hour, and the
// next 12 hours are bars that spring to new values. The sandbox ticks nothing: every motion is a
// declared prop the renderer runs. Three looks (`variant`), on the New Tab page, a pane and a
// sidebar section. Data: src/weather.ts.
import {
  Capsule, cmux, computed, HStack, Icon, newTab, onCleanup, pane, Panel, Particles, section, signal,
  Spacer, Text, TextField, untrack, VStack, ZStack, type View
} from "cmux-extension-sdk"
import { describe, forecast, placeFromIP, placeNamed, preview, type Place, type Reading } from "./weather.ts"

// Open-Meteo refreshes its current conditions every 15 minutes; reading faster gets nothing new.
const REFRESH_MS = 15 * 60_000
const WHITE = "#FFFFFF", DIM = "#FFFFFFB3"

const setting = (name: string) => cmux.app.settings()[name]
const variant = computed(() => String(setting("variant") ?? "sky"))
const previewKind = computed(() => String(setting("preview") ?? "live"))
const fahrenheit = computed(() => setting("units") === "fahrenheit")
const placeName = computed(() => String(setting("place") ?? "").trim())
const fromIP = computed(() => setting("approximateLocation") === true)

const [live, setLive] = signal<Reading | null>(null)
const [problem, setProblem] = signal<string | null>(null)
const [tick, setTick] = signal(0)
const [draft, setDraft] = signal("")
const reading = computed(() => (previewKind() === "live" ? live() : preview(previewKind(), tick())))
// Views bind to R() so a new reading updates them in place (and the bars spring); they are rebuilt
// only when the look or the kind of sky changes.
const R = () => reading() ?? preview("sun", 0)
const shape = computed(() => {
  const r = reading()
  if (!r) return ""
  const d = describe(r.code)
  return `${variant()}|${d.kind}|${d.partly}|${d.heavy}|${r.day}`
})

let located: { key: string; place: Place } | null = null
let inflight: Promise<void> | null = null
function load(): Promise<void> {
  const key = placeName() || (fromIP() ? "@ip" : "")
  if (!key || inflight) return inflight ?? Promise.resolve()
  inflight = (async () => {
    try {
      const place = located?.key === key ? located.place : key === "@ip" ? await placeFromIP() : await placeNamed(key)
      located = { key, place }
      setLive(await forecast(place, fahrenheit()))
      setProblem(null)
    } catch (error) {
      const e = error as { code?: string; message?: string }
      setProblem(e?.code === "scope.missing" ? "Turn on network access for Leo weather in Settings > Apps." : e?.message ?? String(error))
    } finally {
      inflight = null
      // The place changed while this read was out: read the new one.
      if ((placeName() || (fromIP() ? "@ip" : "")) !== key) void load()
    }
  })()
  return inflight
}

// The sky behind everything: a gradient by the place's hour, grayer under cloud.
function skyColors(r: Reading): string[] {
  const { kind } = describe(r.code)
  if (kind === "snow") return r.day ? ["#8FA5BD", "#DCE6EF"] : ["#1E2635", "#47556B"]
  if (kind !== "clear") return r.day ? ["#4E5E72", "#98A6B4"] : ["#121822", "#2C3442"]
  if (!r.day) return ["#070B1E", "#1B2A4E"]
  if (r.hour < 8) return ["#45558A", "#F4A984"]
  if (r.hour >= 17) return ["#2D3A6B", "#F28C6B"]
  return ["#2F7FD8", "#9CD3F7"]
}

// The animated layers of a sky, sized by `s` (1 = a full tab).
function weatherLayers(r: Reading, s: number): View[] {
  const d = describe(r.code)
  const layers: View[] = []
  if (d.kind === "rain" || d.kind === "storm") layers.push(Particles({ preset: "rain", rate: d.kind === "storm" ? 2.5 : d.heavy ? 1.6 : 1 }))
  if (d.kind === "snow") layers.push(Particles({ preset: "snow", rate: d.heavy ? 1.8 : 1 }))
  if (!r.day && (d.kind === "clear" || d.partly)) layers.push(Particles({ preset: "stars", rate: 0.6 }))
  if (d.kind === "clear") {
    layers.push(
      r.day
        ? Icon("sun.max.fill").font(88 * s).color("#FFD45A").glow({ color: "#FFC83D", radius: 36 * s, opacity: 0.85 }).loop({ effect: "spin", period: 30 }).offset({ x: 150 * s, y: -110 * s })
        : Icon("moon.fill").font(64 * s).color("#F4F1DE").glow({ color: "#DCE3FF", radius: 24 * s, opacity: 0.6 }).loop({ effect: "breathe", period: 5, amount: 0.4 }).offset({ x: 150 * s, y: -110 * s })
    )
  }
  if (d.kind !== "clear" || d.partly) {
    const symbol = d.kind === "storm" ? "cloud.bolt.fill" : "cloud.fill"
    layers.push(Icon(symbol).font(110 * s).color("#FFFFFFE6").loop({ effect: "float", period: 4, amount: 2 }).offset({ x: 110 * s, y: -90 * s }))
    layers.push(Icon("cloud.fill").font(70 * s).color("#FFFFFF99").loop({ effect: "float", period: 6, amount: 1.5 }).offset({ x: -170 * s, y: -130 * s }))
  }
  if (d.kind === "storm") layers.push(Icon("bolt.fill").font(40 * s).color("#FFE066").glow({ color: "#FFE066", radius: 18, opacity: 0.9 }).loop({ effect: "pulse", period: 0.9, amount: 3 }).offset({ x: 110 * s, y: -30 * s }))
  return layers
}

// The next 12 hours: one bar per hour, each springing to its new height when the numbers change.
function hourlyBars(height: number, tone: string, labels: boolean): View {
  const temps = () => reading()?.hours.map((h) => h.temperature) ?? []
  const barHeight = (i: number) => {
    const t = temps(), lo = Math.min(...t), hi = Math.max(...t)
    return t.length ? 6 + ((t[i]! - lo) / (hi - lo || 1)) * (height - 6) : 6
  }
  return HStack({ spacing: labels ? 10 : 4 }, Array.from({ length: 12 }, (_, i) =>
    VStack({ spacing: 4 }, [
      labels ? Text(() => `${temps()[i] ?? ""}°`).font("caption2").color(tone) : null,
      Spacer(),
      Capsule().fill(tone).frame(() => ({ width: labels ? 10 : 5, height: barHeight(i) })).animation("snappy"),
      labels ? Text(() => reading()?.hours[i]?.label ?? "").font("caption2").color(tone).opacity(0.7) : null
    ].filter((v): v is View => v !== null)).frame({ height: height + (labels ? 40 : 0) })
  ))
}

const subtitle = (r: Reading) => `${describe(r.code).text} · feels like ${r.feelsLike}° · H ${r.high}° L ${r.low}°`
const placeLine = (r: Reading) => (r.place.region ? `${r.place.name}, ${r.place.region}` : r.place.name)

// Three looks for a tab or pane.
function bigView(): View {
  const r = R()
  const full = { maxWidth: "infinity", maxHeight: "infinity" } as const
  if (variant() === "card") {
    return VStack([
      Spacer(),
      Panel({ style: "glass" }, [
        ZStack([...weatherLayers(r, 0.5), VStack({ spacing: 0 }, [Text(() => `${R().temperature}°`).font(56).weight("light").color(WHITE), Text(() => describe(R().code).text).color(DIM)])])
          .gradient(() => ({ colors: skyColors(R()) })).frame({ width: 420, height: 180 }).cornerRadius(14),
        Text(() => placeLine(R())).font("headline"),
        Text(() => subtitle(R())).color(cmux.theme.text.secondary),
        hourlyBars(48, cmux.theme.accent, true)
      ]).frame({ width: 460 }),
      Spacer()
    ]).gradient(() => ({ colors: skyColors(R()), angle: 135 })).frame(full)
  }
  if (variant() === "minimal") {
    return VStack({ spacing: 10 }, [
      Spacer(),
      ZStack(weatherLayers(r, 0.4).map((v) => v.offset({ x: 0, y: 0 }))).frame({ width: 120, height: 90 }),
      Text(() => `${R().temperature}°`).font(120).weight("ultraLight"),
      Text(() => placeLine(R())).font("title3").color(cmux.theme.text.secondary),
      Text(() => subtitle(R())).font("callout").color(cmux.theme.text.tertiary),
      hourlyBars(36, cmux.theme.text.secondary, false),
      Spacer()
    ]).frame(full)
  }
  return ZStack([
    ...weatherLayers(r, 1),
    VStack({ spacing: 6 }, [
      Spacer(),
      Text(() => placeLine(R())).font("title2").weight("medium").color(WHITE),
      Text(() => `${R().temperature}°`).font(132).weight("thin").color(WHITE),
      Text(() => subtitle(R())).font("title3").color(DIM),
      Spacer(),
      hourlyBars(70, WHITE, true).padding(24)
    ])
  ]).gradient(() => ({ colors: skyColors(R()) })).frame(full)
}

// The same three looks, small enough for the sidebar.
function smallView(): View {
  const r = R()
  const text = VStack({ spacing: 0 }, [Text(() => `${R().temperature}° ${describe(R().code).text}`).font("headline").lineLimit(1), Text(() => placeLine(R())).font("caption").color(cmux.theme.text.secondary).lineLimit(1)])
  if (variant() === "minimal") return VStack({ spacing: 4 }, [text, hourlyBars(18, cmux.theme.text.secondary, false)])
  if (variant() === "card") return HStack({ spacing: 8 }, [ZStack(weatherLayers(r, 0.22).map((v) => v.offset({ x: 0, y: 0 }))).frame({ width: 36, height: 30 }), text, Spacer()])
  return ZStack([
    ...weatherLayers(r, 0.35).map((v) => v.offset({ x: 70, y: 0 })),
    HStack([VStack({ spacing: 0 }, [Text(() => `${R().temperature}°`).font(28).weight("light").color(WHITE), Text(() => describe(R().code).text).font("caption").color(DIM)]), Spacer()]).padding(10)
  ]).gradient(() => ({ colors: skyColors(R()) })).frame({ height: 72 }).cornerRadius(10)
}

function mount(view: () => View): View {
  const every = cmux.timer.every(REFRESH_MS, () => void load())
  // In a preview the bars get new numbers every 4 s, to show them spring.
  const shuffle = cmux.timer.every(4000, () => previewKind() !== "live" && setTick(tick() + 1))
  onCleanup(() => (cmux.timer.clear(every), cmux.timer.clear(shuffle)))
  let seen = ""
  return VStack({ spacing: 6 }, [
    () => {
      const key = `${placeName()}|${fromIP()}|${fahrenheit()}`
      if (key !== seen) (seen = key), (located = null), void load()
      return null
    },
    () => {
      if (shape()) return untrack(view)
      if (!placeName() && !fromIP()) {
        return VStack({ spacing: 4 }, [
          Text("Where are you?").font("headline"),
          TextField(draft, { placeholder: "A city, for the weather", onEdit: setDraft, onSubmit: (t) => void cmux.app.settings.set({ place: t.trim() }) })
        ]).padding(12)
      }
      return Text(problem() ?? "Reading the sky…").color(cmux.theme.text.secondary).padding(12)
    }
  ])
}

export const renderNewTab = newTab(() => mount(bigView))
export const renderPane = pane(() => mount(bigView))
export const renderSection = section(() => mount(smallView))
