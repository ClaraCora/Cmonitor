// Natural Earth, public domain. Rebuild with scripts/build-visitor-map.py.
import world from "./visitor-world.json"

export const WORLD_VIEW_BOX = "0 0 960 480"
export const WORLD_AREAS: readonly { code: string; path: string }[] =
  Object.entries(world.areas).map(([code, path]) => ({ code, path }))

const points: Record<string, [number, number]> = Object.fromEntries(
  Object.entries(world.points).map(([code, [x, y]]) => [code, [x, y]]),
)

export function getVisitorCountryPoint(code: string): [number, number] | undefined {
  return Object.hasOwn(points, code) ? points[code] : undefined
}

const alias: Record<string, string> = {
  UK: "GB", USA: "US", "United States of America": "US", "United Kingdom": "GB",
  "South Korea": "KR", "North Korea": "KP", "Russian Federation": "RU",
  "Czech Republic": "CZ", Türkiye: "TR", "Viet Nam": "VN", Macau: "MO",
  香港: "HK", 中国香港: "HK", "Hong Kong": "HK", 澳门: "MO", 澳門: "MO", 中国澳门: "MO",
  台湾: "TW", 台灣: "TW", 中国台湾: "TW", 中华人民共和国: "CN", 中国大陆: "CN",
}

function nameKey(raw: string) {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

let names: Map<string, string> | undefined
export function normalizeVisitorCountry(raw: string): string | null {
  const value = (raw || "").trim()
  if (!value) return null
  const code = value.toUpperCase()
  if (Object.hasOwn(points, code)) return code
  if (!names) {
    names = new Map()
    if (typeof Intl.DisplayNames === "function") {
      for (const locale of ["zh-CN", "zh-TW", "en"]) {
        const display = new Intl.DisplayNames([locale], { type: "region" })
        for (const region of Object.keys(points)) {
          const label = display.of(region)
          if (label) names.set(nameKey(label), region)
        }
      }
    }
    for (const [label, region] of Object.entries(alias)) names.set(nameKey(label), region)
  }
  return names.get(nameKey(value)) ?? null
}
