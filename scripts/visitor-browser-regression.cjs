// Exercise the shipped admin bundle with synthetic visitor data only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../web-admin/node_modules/playwright')

const codes = [
  ['CN', '上海', 'AS64500 示例网络', 21], ['US', 'Seattle', 'AS64501 Example Transit', 14],
  ['JP', 'Tokyo', 'AS64502 Example Network', 8], ['DE', 'Frankfurt', '', 6],
  ['SG', 'Singapore', '', 5], ['GB', 'London', '', 3], ['BR', 'São Paulo', '', 2],
  ['AU', 'Sydney', '', 1], ['', '', '', 2],
]
const fixture = []
for (let i = 0; i < 21; i++) {
  for (const [country,city,org,count] of codes) {
    if (i >= count) continue
    const id = fixture.length + 1
    fixture.push({ id, ip: id % 2 ? '2001:db8:1234:5678:abcd:ef01:2345:6789' : '192.0.2.13',
      country, city, org, ts: 1795432080 - id * 37, ua: 'ExampleBrowser/1.0 ' + 'a'.repeat(160) })
  }
}
const origin = 'https://hub.example.test'
const dist = path.resolve(process.env.UX_DIST || path.join(__dirname, '../web-admin/dist'))
const output = process.env.VISITOR_SCREENSHOTS
async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.env.UX_BROWSER_CHANNEL ? { channel: process.env.UX_BROWSER_CHANNEL } : {}) })
  let rows = fixture.slice(), cleared = 0
  try {
    const page = await browser.newPage({ viewport: {width: 1440,height: 930}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) throw Error('unexpected external request ' + url.origin)
      const pathname = url.pathname
      if (pathname === '/api/me') return route.fulfill({json:{authed:true,site_name:'Cmonitor',hub_version:'1.9.5'}})
      if (pathname === '/api/nodes') return route.fulfill({json:{nodes:[],admin:true}})
      if (pathname === '/api/visitor-log') {
        if (route.request().method() === 'DELETE') { rows = []; cleared++; return route.fulfill({json:{}}) }
        return route.fulfill({json:{visits:rows}})
      }
      if (pathname.startsWith('/api/')) return route.fulfill({json:{}})
      return route.fulfill({path:path.join(dist, pathname === '/clara/visitors' ? 'index.html' : pathname.slice('/clara/'.length))})
    })
    await page.routeWebSocket('**/api/ws', ws => ws.send(JSON.stringify({nodes:[],admin:true})))
    await page.goto(origin + '/clara/visitors')
    const atlas = page.getByRole('img', {name:/访客世界分布图/})
    const records = page.getByRole('list', {name:'访问记录'}).getByRole('listitem')
    const filter = label => page.getByRole('button', {name:label,exact:true})
    const reset = filter('显示全部')
    await atlas.waitFor()
    assert.equal(await records.count(), fixture.length)
    if (output) {
      fs.mkdirSync(output, {recursive:true})
      await page.screenshot({path:path.join(output,'visitor-map-desktop.png')})
    }
    await filter('筛选中国，21 次访问').focus()
    await page.keyboard.press('Enter')
    assert.equal(await records.count(), 21)
    await reset.click()
    await atlas.locator('g').filter({hasText:'新加坡'}).click()
    assert.equal(await records.count(), 5, 'small-country marker filters records')
    await reset.click()
    await filter('查看全部 8 个地区').click()
    await filter('筛选澳大利亚，1 次访问').click()
    assert.equal(await records.count(), 1, 'expanded list exposes all regions')
    await reset.click()
    await filter('收起排行').click()
    await filter('筛选未定位，2 次访问').click()
    assert.equal(await records.count(), 2)
    rows = fixture.filter(v => v.country)
    await filter('刷新').click()
    await page.getByText('共 60 条', {exact:true}).waitFor()
    assert.equal(await reset.count(), 0, 'refresh drops a selection that disappeared')
    rows = fixture
    await filter('刷新').click()
    await filter('筛选未定位，2 次访问').waitFor()
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844})
      await page.evaluate(() => window.scrollTo(0,0))
      if (width === 390) {
        if (output) await page.screenshot({path:path.join(output,'visitor-map-mobile.png')})
        const land = atlas.locator('path[data-shade="0"]').first()
        const lightColor = await land.evaluate(el => getComputedStyle(el).fill)
        await page.getByTitle('切换主题').click()
        await page.locator('html.dark').waitFor()
        assert.notEqual(await land.evaluate(el => getComputedStyle(el).fill), lightColor)
        if (output) await page.screenshot({path:path.join(output,'visitor-map-mobile-dark.png'), animations:'disabled'})
      }
      const ua = records.first().locator('summary')
      await ua.focus()
      await page.keyboard.press('Enter')
      await records.first().locator('details[open] p').waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded UA fits at '+width)
      await ua.click()
    }
    rows = [{...fixture[0],country:'non-geographic value'}]
    await filter('刷新').click()
    await filter('筛选未定位，1 次访问').waitFor()
    assert.equal(await atlas.locator('path.va-region').count(), 0, 'unrecognized country does not acquire a location')
    await filter('清空访客记录').click()
    await page.getByRole('dialog').getByRole('button',{name:'取消'}).click()
    assert.equal(cleared,0)
    await filter('清空访客记录').click()
    await page.getByRole('dialog').getByRole('button',{name:'清空',exact:true}).click()
    await page.getByText('还没有访客记录', {exact:true}).waitFor()
    assert.equal(cleared,1)
    assert(await atlas.isVisible(), 'zero records retain the neutral map')
    assert.equal(await atlas.locator('path.va-region').count(),0)
    assert.equal(await records.count(),0)
    assert.deepEqual(errors,[])
    console.log('Visitor map, region filters, refresh, clear and responsive records passed.')
  } finally { await browser.close() }
}
run().catch(e => { console.error(e); process.exitCode = 1 })
