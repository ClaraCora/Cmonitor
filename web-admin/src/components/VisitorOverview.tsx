import { useMemo, useRef, useState } from "react"
import { ArrowDown, ChevronDown, MapPinOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { VisitorRow } from "@/lib/api"
import { getVisitorCountryPoint, normalizeVisitorCountry, WORLD_AREAS, WORLD_VIEW_BOX } from "@/lib/visitor-geography"
import "./visitor-overview.css"

const regions = new Intl.DisplayNames(["zh-CN"], { type: "region" })
const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
const areaCodes = new Set(WORLD_AREAS.map(area => area.code))
const smallRegions = new Set(["HK", "MO", "SG", "BH", "LU", "MT", "LI", "AD", "SM", "MC", "VA"])
const groups = ["无访问", "1", "2–5", "6–15", "16+"]
const UNKNOWN = "unknown"
const rankLimit = 5

function regionName(code: string) {
  return code === UNKNOWN ? "未定位" : regions.of(code) || code
}

function shade(count: number) {
  if (count > 15) return 4
  if (count > 5) return 3
  if (count > 1) return 2
  return count
}

function Atlas({ counts, selected, choose }: {
  counts: Map<string, number>
  selected: string | null
  choose: (code: string) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const readout = hover && counts.has(hover) ? hover : selected
  const dots = [...counts.keys()].filter(code => code !== UNKNOWN && (!areaCodes.has(code) || smallRegions.has(code)))
  const controls = (code: string) => ({
    className: "va-region",
    "data-selected": selected === code || undefined,
    "data-shade": shade(counts.get(code)!),
    onClick: () => choose(code),
    onMouseEnter: () => setHover(code),
    onMouseLeave: () => setHover(null),
  })
  return <div className="va-figure">
    {/* The adjacent native buttons expose the same filters, including tiny islands, to keyboard and touch. */}
    <svg viewBox={WORLD_VIEW_BOX} role="img" aria-label="访客世界分布图，各地区访问次数见地区排行">
      {WORLD_AREAS.map(area => counts.has(area.code)
        ? <path key={area.code} d={area.path} {...controls(area.code)}><title>{regionName(area.code)} · {counts.get(area.code)} 次访问</title></path>
        : <path key={area.code} d={area.path} data-shade="0" />)}
      {dots.map(code => {
        const point = getVisitorCountryPoint(code)
        return point && <g key={code} {...controls(code)}>
          <title>{regionName(code)} · {counts.get(code)} 次访问</title>
          <circle cx={point[0]} cy={point[1]} r="7" fill="transparent" stroke="none" />
          <circle className="va-point" cx={point[0]} cy={point[1]} r="3.8" />
        </g>
      })}
    </svg>
    <div className="va-legend">
      <span>访问次数</span>{groups.map((label, index) => <span className="va-key" key={label}><i data-shade={index} />{label}</span>)}
    </div>
    {readout && readout !== UNKNOWN && <div aria-hidden="true" className="va-readout">{regionName(readout)} · {counts.get(readout)} 次</div>}
  </div>
}

function RecordItem({ visit, code }: { visit: VisitorRow; code: string }) {
  const org = (visit.org || "").trim()
  const match = org.match(/^(AS\d+)\s*(.*)$/i)
  const provider = match ? match[2] : org
  const country = code === UNKNOWN ? visit.country : regionName(code)
  const place = [...new Set([country, visit.region, visit.city].filter(Boolean))].join(" · ")
  const ts = new Date(visit.ts * 1000)
  return <li className="va-record">
    <time dateTime={ts.toISOString()} className="va-time"><span>{time.format(ts)}</span><small>{date.format(ts)}</small></time>
    <div><span className="va-ip">{visit.ip}</span><small>{place || "归属地未知"}</small></div>
    <div><span>{provider || "服务商未知"}</span>{match && <small>{match[1].toUpperCase()}</small>}</div>
    {visit.ua ? <details><summary>查看 UA</summary><p>{visit.ua}</p></details> : <small>无 UA 记录</small>}
  </li>
}

export default function VisitorOverview({ rows }: { rows: VisitorRow[] }) {
  const [filter, setFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const { visits, counts, ranked } = useMemo(() => {
    const counts = new Map<string, number>()
    const visits = rows.map(visit => {
      const code = normalizeVisitorCountry(visit.country || "") || UNKNOWN
      counts.set(code, (counts.get(code) || 0) + 1)
      return { visit, code }
    })
    const ranked = [...counts.entries()].filter(([code]) => code !== UNKNOWN)
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    return { visits, counts, ranked }
  }, [rows])
  const selected = filter && counts.has(filter) ? filter : null
  if (filter && !selected) setFilter(null)
  const visible = selected ? visits.filter(row => row.code === selected) : visits
  const choose = (code: string) => setFilter(value => value === code ? null : code)
  const unknown = counts.get(UNKNOWN) || 0
  const shown = expanded ? ranked : ranked.slice(0, rankLimit)
  const leader = ranked[0]?.[1] || 1

  return <div className="va-page">
    <section className="va-panel" aria-label="访客分布">
      <div className="va-map-side">
        <div className="va-overview-head">
          <h2>访客分布</h2>
          <p><strong>{visits.length}</strong> 次访问<span aria-hidden="true"> · </span><strong>{ranked.length}</strong> 个国家和地区</p>
        </div>
        <Atlas counts={counts} selected={selected} choose={choose} />
      </div>
      <div className="va-rank-side">
        <div className="va-rank-head">
          <h3>地区排行</h3>
          {selected && <Button type="button" variant="ghost" size="sm" className="min-h-10" onClick={() => {
            detailHeading.current?.focus({ preventScroll: true })
            detailHeading.current?.scrollIntoView({ block: "start" })
          }}>查看 {visible.length} 条明细<ArrowDown aria-hidden="true" /></Button>}
        </div>
        {ranked.length > 0 ? <ol aria-label="地区访问次数排行" className="va-ranks" data-expanded={expanded || undefined}>
          {shown.map(([code, count]) => <li key={code}>
            <Button type="button" variant="choice" size="sm" className="va-rank" aria-label={`筛选${regionName(code)}，${count} 次访问`}
              aria-pressed={selected === code} onClick={() => choose(code)}>
              <span className="va-rank-name">{regionName(code)}</span><span className="va-count">{count} <small>次</small></span>
              <span aria-hidden="true" className="va-bar"><i style={{ width: `${count / leader * 100}%` }} /></span>
            </Button>
          </li>)}
        </ol> : <p className="va-no-geo">{visits.length ? "当前记录暂无可定位的国家或地区。" : "收到可定位的访问后，这里会显示地区排行。"}</p>}
        {ranked.length > rankLimit && <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} className="va-expand min-h-9" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起排行" : `查看全部 ${ranked.length} 个地区`}<ChevronDown aria-hidden="true" /></Button>}
        {unknown > 0 && <Button type="button" variant="choice" size="sm" className="va-unknown" aria-label={`筛选未定位，${unknown} 次访问`} aria-pressed={selected === UNKNOWN} onClick={() => choose(UNKNOWN)}>
          <span><MapPinOff aria-hidden="true" />未定位</span><span className="va-count">{unknown} <small>次</small></span>
        </Button>}
      </div>
    </section>
    <section className="va-log" aria-label="访问明细">
      <div className="va-log-title"><h2 ref={detailHeading} tabIndex={-1}>访问明细</h2>
        <p role="status">{selected ? `${regionName(selected)} · ${visible.length} 条` : `共 ${visible.length} 条`}</p>
        {selected && <Button variant="ghost" size="sm" className="ml-auto min-h-10" type="button" onClick={() => setFilter(null)}><X aria-hidden="true" />显示全部</Button>}
      </div>
      <div className="va-table">
        {visits.length > 0 && <div className="va-columns" aria-hidden="true"><span>访问时间</span><span>IP 与归属地</span><span>服务商与 ASN</span><span>客户端</span></div>}
        <ol aria-label="访问记录">{visible.map(({ visit, code }) => <RecordItem key={visit.id} visit={visit} code={code} />)}</ol>
        {!visits.length && <div className="va-empty"><h3>还没有访客记录</h3><p>状态页收到访问后，记录会出现在这里。</p></div>}
      </div>
    </section>
  </div>
}
