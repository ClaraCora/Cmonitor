/* Built-asset regression. All data and writes stay on an ephemeral loopback server. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../web-admin/node_modules/playwright')
const mode = process.env.UX_APP || 'admin'
const dist = path.resolve(process.env.UX_DIST || path.join(__dirname, '../web-admin/dist'))
const output = path.resolve(process.env.UX_OUTPUT || path.join(__dirname, '../target/ux-evidence'))

const metric = { uptime: 1000, cpu: 5, load: [0, 0, 0], mem_total: 1024, mem_used: 128, swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 256, net_rx: 10, net_tx: 20, total_rx: 1000, total_tx: 2000, month_rx: 100, month_tx: 200, tcp: 3, udp: 1, procs: 10 }
const nodes = (mode === 'admin' ? [1, 2, 3, 4] : [1, 2]).map(id => ({ id, name: `测试节点 ${id}`, sort: id, public: true, online: true, country: 'SG', last_seen: Math.floor(Date.now()/1000), metrics: metric, hostname: 'fixture', ip: `198.51.100.${id}`, ipv4: '', ipv6: '', os: 'Linux', kernel: '', arch: 'x86_64', virt: 'kvm', cpu_name: 'Test CPU', cpu_cores: 2, mem_total: 1024, swap_total: 0, disk_total: 2048, agent_version: '1.2.0', price: 5, currency: 'USD', billing_cycle: 'monthly', expires_at: '2026-12-10', permanent: false, traffic_limit: 1024**3, traffic_mode: 'sum', traffic_reset_day: 1, total_rx: 1000, total_tx: 2000, month_rx: 100, month_tx: 200, month_start: '2026-11-01', day_rx: 10, day_tx: 20, traffic_incomplete: false, token: 'fixture-only', notify: true, muted_until: 0, remark: '', tags: '', website: 'https://example.com', pings: [{id: 1, name: '测试探测', latency: 20, updated_at: Math.floor(Date.now()/1000), samples: [20,21,19]}] }))
const settings = { site_name: 'Monitor', retention_days: '7', public_page: 'on', visitor_card: 'on', notify_grace: '3', notify_traffic: '80', notify_expiry: '7', notify_disk_percent: '90', notify_disk_minutes: '10', notify_ping_failures: '3', notify_cooldown: '60', notify_login: 'on', notify_telegram_chat: '', notify_telegram_text: '{{title}}', notify_webhook_body: '{"text":"{{message}}"}', password_login: 'on' }
const me = { authed: true, github: false, password_login: true, hub_version: 'test', site_name: 'Monitor', public_page: true, site: 'https://monitor.example.com', can_provision: true, admin_url: '/clara/nodes', visitor_card: true }
const visitor = {
  id: 1, ts: 1794280900, ip: '2001:0db8:0000:0000:1234:5678:abcd:ef01',
  city: 'Singapore', country: 'SG', org: 'AS64496 Example Networks',
  ua: 'LayoutFixture/' + 'long-client-identifier'.repeat(12),
}
const pingTask = { id: 1, name: 'IPv6 出口', target: '[2001:0db8:0000:0000:1234:5678:abcd:ef01]:443', interval: 60, nodes: [1] }
if (mode === 'admin') {
  Object.assign(nodes[0], {ipv4: nodes[0].ip, ipv6: '2001:0db8:0000:0000:1234:5678:abcd:ef01'})
  Object.assign(nodes[1], {name: 'Singapore-Production-Monitoring-Node-Long-Name', terminal_reason: 'plaintext', offline_only: true, price: 1188, currency: 'CNY', billing_cycle: 'yearly'})
  Object.assign(nodes[2], {terminal_enabled: false})
}

async function main() {
  fs.mkdirSync(output, { recursive: true })
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/clara(?=\/|$)/, '')
    let filename = path.join(dist, pathname)
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) filename = path.join(dist, 'index.html')
    const ext = path.extname(filename)
    res.setHeader('Content-Type', ({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'})[ext] || 'application/octet-stream')
    fs.createReadStream(filename).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const localOrigin = `http://127.0.0.1:${server.address().port}`
  const origin = mode === 'admin' ? 'https://hub.example.test' : localOrigin
  const browser = await chromium.launch({ headless: true, ...(process.env.UX_BROWSER_CHANNEL ? { channel: process.env.UX_BROWSER_CHANNEL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', hasTouch: true })
  let settingsFail = false, pingFail = false, outage = false, authed = true, restorePhase = 'applying', restoreId = ''
  let backupState = 'active', backupFail = false, backupError = '', backupStale = false
  const sockets = new Set(), timers = new Set(), writes = [], historyCalls = []
  const errors = []
  try {
    if (mode === 'admin') {
      // Exercise the HTTPS-only provisioning controls with the same local build.
      await context.route(origin + '/**', async route => {
        const {pathname, search} = new URL(route.request().url())
        await route.fulfill({response: await route.fetch({url: localOrigin + pathname + search})})
      })
    }
    await context.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname
      const fail = body => route.fulfill({status:503,body})
      if (pathname === '/api/auth/session') return route.fulfill({status:authed ? 204 : 401})
      if (pathname === '/api/agent-upgrades' && req.method()==='GET') return route.fulfill({json:{target:'1.2.1',nodes:{1:'ready',2:'plaintext',3:'ready',4:'ready'},batch:null}})
      if (outage && pathname === '/api/nodes') return fail('模拟网络中断')
      if (settingsFail && pathname === '/api/settings') return fail('模拟设置加载失败')
      if (pingFail && pathname === '/api/ping-tasks') return fail('模拟探测加载失败')
      if (backupFail && pathname === '/api/db') return fail('模拟备份状态加载失败')
      if (req.method() !== 'GET') {
        writes.push({ pathname, method:req.method(), body:req.postData() })
        if (pathname === '/api/settings' && req.method() === 'PUT') {
          const patch=JSON.parse(req.postData())
          if (typeof patch.preset_tag==='string') patch.preset_tag=[...new Set(patch.preset_tag.split(/[;；\r\n]/).map(tag=>tag.trim()).filter(Boolean))].join(';')
          Object.assign(settings,patch)
        }
        if (pathname === '/api/auth/logout') return fail('模拟退出失败')
        if (/^\/api\/db\/restore\/[a-f0-9]{32}\/apply$/.test(pathname)) {
          restoreId = pathname.split('/')[4]
          authed = false
          for (const ws of sockets) ws.close()
          // The server committed the request, but the response was lost.
          return route.abort('connectionreset')
        }
        return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})})
      }
      let data = {}
      if (pathname === '/api/me') data = {...me,authed}
      else if (pathname === '/api/nodes') data = {nodes,admin:authed}
      else if (pathname === '/api/db') data = {path:'fixture.db',size:1024,wal:0,free:0,oldest:null,retention:7,rows:{},backup_success:'1794280900',backup_error:backupError,scheduled_backup:{scheduler:{state:backupState,boot_enabled:true,calendar:'*-*-* 03:20:00',random_delay:'10min',next_run:backupState==='active'?'Wed 2026-11-11 03:21:27 CST':null},policy:{directory:'/opt/monitor/backups',keep:7,offsite:false},copies:1,checked_at:1794280900,timezone:'UTC+08:00',stale:backupStale}}
      else if (/^\/api\/db\/restore\/[a-f0-9]{32}$/.test(pathname)) data = {phase:restorePhase}
      else if (pathname === '/api/settings') data = settings
      else if (pathname === '/api/themes') data = {themes:[{name:'默认主题',short:'default',description:'默认公开状态页',version:'1.9.1',author:'Cmonitor',url:'',selected:true,builtin:true}]}
      else if (pathname === '/api/terminal/history') data = {items:[]}
      else if (pathname.endsWith('/metrics')) {
        historyCalls.push(req.url())
        const now=Math.floor(Date.now()/1000)
        data={metrics:[{ts:now-60,cpu:5,mem_used:128,disk_used:256,net_rx:10,net_tx:20},{ts:now,cpu:6,mem_used:130,disk_used:256,net_rx:20,net_tx:20}],ping:[{task_id:1,ts:now-60,latency:20},{task_id:1,ts:now,latency:21}],probes:{1:'测试探测'},loss:{}}
      }
      else if (pathname === '/api/ping-tasks') data={tasks:[pingTask]}
      else if (pathname === '/api/visitor-log') data={visits:[visitor]}
      else if (pathname === '/api/visitor') data={ip:'198.51.100.99',city:'测试地区',country:'CN'}
      else if (pathname.endsWith('/renewals')) data={history:[]}
      else if (pathname === '/api/notify/history') data={items:[]}
      else if (pathname === '/api/sessions') data=[]
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
    })
    await context.routeWebSocket(/\/api\/ws(?:\?|$)/, ws => {
      if (outage) { ws.close(); return }
      sockets.add(ws)
      ws.onClose(() => sockets.delete(ws))
      const send=() => { try { ws.send(JSON.stringify({nodes,admin:authed})) } catch {} }
      send()
      const timer=setInterval(() => { if (outage) {ws.close();clearInterval(timer)} else send() },1000)
      timers.add(timer)
    })
    const page=await context.newPage()
    await page.clock.install()
    page.on('pageerror',e => errors.push(e.message))
    if (mode === 'admin') {
      // A failed first node request must not take the navigation or independent pages offline.
      outage = true
      await page.goto(origin+'/clara/nodes')
      await page.getByRole('button',{name:'重新加载节点'}).waitFor()
      await page.getByRole('link',{name:'设置',exact:true}).click()
      await page.getByLabel('站点名称',{exact:true}).waitFor()
      assert.equal(await page.title(), '设置 · Monitor 后台')
      await page.getByRole('link',{name:'数据与备份',exact:true}).click()
      await page.getByRole('heading',{name:'自动备份',exact:true}).waitFor()
      await page.goto(origin+'/clara/unknown-page')
      await page.getByRole('heading',{name:'后台页面不存在'}).waitFor()
      await page.getByRole('button',{name:'返回节点管理'}).click()
      await page.getByRole('button',{name:'重新加载节点'}).waitFor()
      outage = false
      await page.getByRole('button',{name:'重新加载节点'}).click()
      await page.getByRole('button',{name:'添加节点',exact:true}).waitFor()
      await page.reload()
      const skipLink = page.getByRole('link', {name: '跳转到后台内容'})
      const main = page.getByRole('main', {name: '节点', exact: true})
      await skipLink.waitFor()
      await main.waitFor()
      await page.keyboard.press('Tab')
      assert(await skipLink.evaluate(link => document.activeElement === link), 'first tab reaches the main-content skip link')
      await page.keyboard.press('Enter')
      assert(await main.evaluate(element => document.activeElement === element), 'skip link moves keyboard focus to main')
      await page.keyboard.press('Tab')
      assert(await main.evaluate(element => element.contains(document.activeElement)), 'the next tab stays in page content and skips the navigation')
      const sections = [
        ['访客', '访问明细'], ['延迟', pingTask.name], ['通知', '提醒规则'],
        ['数据与备份', '自动备份'], ['主题', '默认主题'], ['安全', '应急密码'], ['设置', '公开状态页'],
      ]
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({width, height: width < 768 ? 844 : 1000})
        for (const [label, heading] of sections) {
          const link = page.getByRole('navigation').getByRole('link',{name:label,exact:true})
          await link.click()
          await page.getByRole('heading',{name:heading,exact:true}).waitFor()
          assert.equal(await link.getAttribute('aria-current'), 'page')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} fits at ${width}px`)
        }
      }
      await page.goto(localOrigin+'/clara/nodes')
      const restrictedInstall = page.getByRole('group', {name: `${nodes[0].name} 操作`, exact:true}).getByRole('button', {name:'安装 Agent'})
      await restrictedInstall.waitFor()
      assert(await restrictedInstall.isDisabled(), 'plain HTTP shows the disabled install action')
      await page.goto(origin+'/clara/nodes')
      const firstActions = page.getByRole('group', {name: `${nodes[0].name} 操作`, exact: true})
      const inventoryTable = page.getByRole('table', {name: '节点列表'})
      const httpActions = page.getByRole('group', {name: `${nodes[1].name} 操作`, exact: true})
      const blockedActions = page.getByRole('group', {name: `${nodes[2].name} 操作`, exact: true})
      for (const width of [320, 390, 767, 768, 1024, 1086, 1280, 1440]) {
        await page.setViewportSize({width, height: width < 768 ? 844 : 1000})
        await firstActions.waitFor()
        if (width >= 768) {
          assert.deepEqual(await inventoryTable.getByRole('columnheader').allTextContents(),
            ['名称', 'IP', '状态', '流量', '价格', '到期', '操作'], `seven-column node table at ${width}px`)
        } else {
          assert.equal(await inventoryTable.count(), 0, `mobile list at ${width}px`)
          assert(await page.getByRole('listitem').filter({has: firstActions}).isVisible())
        }
        for (const name of ['升级 Agent', '批量添加', '添加节点']) {
          await page.getByRole('button', {name, exact:true}).click({trial:true})
        }
        const moveUp = firstActions.getByRole('button', {name:'上移', exact:true})
        assert(await moveUp.isVisible() && await moveUp.isDisabled(), 'first node shows the disabled move-up action')
        for (const name of [/隐藏/, /打开.*终端|打开 Web Terminal/, /禁用.*终端/, /安装 Agent/, /编辑/, /续费/, /删除/, /下移/]) {
          const button = firstActions.getByRole('button', {name})
          // Check that the button receives clicks without executing maintenance actions.
          await button.click({trial:true})
        }
        assert(await httpActions.getByRole('button', {name: /HTTP/}).isDisabled())
        await httpActions.getByRole('button', {name:'上移', exact:true}).click({trial:true})
        const blockedTerminal = blockedActions.getByRole('button', {name:'管理员已禁用终端', exact:true})
        assert(await blockedTerminal.isVisible() && await blockedTerminal.isDisabled())
        assert.equal(await blockedTerminal.evaluate(button => document.getElementById(button.getAttribute('aria-describedby'))?.textContent),
          '终端不可用：管理员已禁用终端')
        assert.equal(await blockedActions.getByRole('button').count(), 9, 'a disabled terminal keeps all nine actions in view')
        await blockedActions.getByRole('button', {name:'允许节点终端', exact:true}).click({trial:true})
        await page.getByRole('button', {name:'复制升级命令', exact:true}).click({trial:true})
        const clipped = await firstActions.evaluate(group => {
          const bounds = group.getBoundingClientRect()
          return [...group.querySelectorAll('button')].some(button => {
            const rect = button.getBoundingClientRect()
            return rect.width === 0 || rect.height === 0 || rect.left < Math.max(0, bounds.left) - 1 ||
              rect.right > Math.min(document.documentElement.clientWidth, bounds.right) + 1 ||
              rect.bottom > bounds.bottom + 1
          })
        })
        assert.equal(clipped, false, `node actions fit their row and viewport at ${width}px`)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `nodes fit at ${width}px`)
        if ([390, 768, 1086, 1440].includes(width)) {
          await page.mouse.move(0, 0)
          await page.evaluate(() => window.scrollTo(0, 0))
          await page.screenshot({animations:'disabled', path:path.join(output, `nodes-${width}.png`)})
          if (width === 1086) {
            const themeToggle = page.getByRole('button', {name:'切换主题', exact:true})
            await themeToggle.click()
            await page.locator('html.dark').waitFor()
            await page.screenshot({animations:'disabled', path:path.join(output, 'nodes-1086-dark.png')})
            await themeToggle.click()
          }
        }
      }
      await page.getByRole('button',{name:'升级 Agent',exact:true}).click()
      const picker=page.getByRole('dialog'); await picker.getByRole('checkbox').first().waitFor()
      assert(await picker.getByRole('checkbox').nth(1).isDisabled(),'HTTP node cannot be selected')
      await picker.getByRole('checkbox').nth(3).check()
      await picker.getByRole('button',{name:'全选可升级节点'}).click()
      await picker.getByText('首台验证：测试节点 4').waitFor()
      assert.equal(await picker.getByRole('checkbox',{checked:true}).count(),3)
      await page.screenshot({animations:'disabled',path:path.join(output,'rollout-desktop.png')})
      await page.setViewportSize({width:390,height:844})
      await page.screenshot({animations:'disabled',path:path.join(output,'rollout-mobile.png')})
      await picker.getByRole('button',{name:'开始升级（3 台）'}).click()
      assert.deepEqual(JSON.parse(writes.find(w=>w.pathname==='/api/agent-upgrades').body),{nodes:[4,1,3]})
      await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000})
      const editButton = page.getByRole('button',{name:'编辑节点',exact:true}).first()
      await editButton.focus()
      await page.keyboard.press('Enter')
      const dialog=page.getByRole('dialog')
      await dialog.getByLabel('流量计算方式',{exact:true}).waitFor()
      await dialog.getByLabel('名称',{exact:true}).fill('未保存修改')
      const labelCounts=await dialog.locator('input').evaluateAll(inputs=>inputs.map(el=>el.labels.length || (el.getAttribute('aria-label') ? 1 : 0)))
      assert(labelCounts.every(Boolean),'every input has an accessible name')
      page.once('dialog',d=>d.dismiss())
      await page.keyboard.press('Escape')
      assert.equal(await dialog.count(),1,'Escape preserves dirty edits when discard is declined')
      await dialog.getByLabel('名称',{exact:true}).fill(nodes[0].name+' 已编辑')
      await dialog.getByRole('button',{name:'保存',exact:true}).click()
      await dialog.waitFor({state:'hidden'})
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '编辑节点')
      const saves=writes.filter(w=>w.pathname===`/api/nodes/${nodes[0].id}`)
      assert.equal(saves.length,1)
      assert.equal(writes.filter(w=>w.pathname.endsWith('/traffic')).length,0,'one atomic save request')
      assert('traffic_correction' in JSON.parse(saves[0].body))
      await page.screenshot({animations:"disabled",path:path.join(output,'admin-desktop.png')})
      await page.setViewportSize({width:390,height:844})
      await page.clock.fastForward(5000)
      await page.getByRole('button',{name:'编辑',exact:true}).first().tap()
      await page.getByLabel('名称',{exact:true}).waitFor()
      await page.screenshot({animations:"disabled",path:path.join(output,'editor-mobile.png')})
      await page.keyboard.press('Escape')
      await firstActions.getByRole('button',{name:'下移',exact:true}).tap()
      assert(writes.some(w=>w.pathname==='/api/nodes/order'),'mobile sorting uses explicit controls')
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({animations:"disabled",path:path.join(output,'admin-mobile.png')})
      const nav = page.getByRole('navigation', {name:'后台导航'})
      await nav.getByRole('link', {name:'访客', exact:true}).click()
      await page.getByText(visitor.ip, {exact:true}).waitFor()
      await page.getByText('查看 UA', {exact:true}).focus()
      await page.keyboard.press('Enter')
      await page.getByText(visitor.ua, {exact:true}).waitFor()
      await page.setViewportSize({width:320,height:640})
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'full IPv6 and expanded UA fit narrow screens')
      const lastLink = await nav.getByRole('link', {name:'设置', exact:true}).boundingBox()
      assert(lastLink && lastLink.x >= 0 && lastLink.x + lastLink.width <= 320, 'last mobile route is visible without sideways scrolling')
      await nav.getByRole('link', {name:'通知',exact:true}).click()
      await page.getByText('Webhook', {exact:true}).click()
      await page.getByLabel('接收渠道', {exact:true}).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'expanded Webhook settings fit mobile')
      await nav.getByRole('link', {name:'安全',exact:true}).click()
      await page.getByRole('heading', {name:'应急密码'}).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'security settings fit mobile')
      await page.setViewportSize({width:390,height:844})
      settingsFail=true
      await page.goto(origin+'/clara/settings')
      await page.getByRole('button',{name:'重新加载',exact:true}).click()
      await page.getByText('加载失败：模拟设置加载失败').waitFor()
      settingsFail=false
      await page.getByRole('button',{name:'重新加载',exact:true}).click()
      await page.getByLabel('站点名称',{exact:true}).waitFor()
      await page.getByLabel('预设筛选标签',{exact:true}).fill(' 游走 ')
      await page.getByRole('button',{name:'保存站点设置',exact:true}).click()
      await page.getByText('已保存',{exact:true}).waitFor()
      assert.equal(settings.preset_tag,'游走','site settings save trims the preset label')
      await page.reload()
      assert.equal(await page.getByLabel('预设筛选标签',{exact:true}).inputValue(),'游走','saved preset survives reload')
      await page.getByLabel('预设筛选标签',{exact:true}).fill(' 游走\n主力；备用;游走 ')
      await page.getByRole('button',{name:'保存站点设置',exact:true}).click()
      await page.getByText('已保存',{exact:true}).waitFor()
      assert.equal(JSON.parse(writes.filter(w=>w.pathname==='/api/settings').at(-1).body).preset_tag,'游走\n主力；备用;游走','multiline presets reach the Hub intact')
      await page.reload()
      assert.equal(await page.getByLabel('预设筛选标签',{exact:true}).inputValue(),'游走;主力;备用','canonical multiple presets survive reload')
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'multiline preset settings fit mobile')
      await page.screenshot({animations:'disabled',path:path.join(output,'multiple-presets-settings-mobile.png')})
      await page.getByLabel('预设筛选标签',{exact:true}).fill('')
      await page.getByRole('button',{name:'保存站点设置',exact:true}).click()
      await page.getByText('已保存',{exact:true}).waitFor()
      assert.equal(settings.preset_tag,'','the preset can be cleared')
      await page.getByRole('button',{name:'退出登录',exact:true}).click()
      await page.getByText('退出失败，请重试',{exact:true}).waitFor()
      assert(page.url().endsWith('/clara/settings'),'failed logout must not navigate')
      pingFail=true
      await page.goto(origin+'/clara/ping')
      await page.getByText('加载失败：模拟探测加载失败').waitFor()
      assert.equal(await page.getByText('还没有延迟监控。',{exact:false}).count(),0)
      pingFail=false
      await page.getByRole('button', {name:'重新加载'}).click()
      await page.getByText(pingTask.target, {exact:true}).waitFor()
      await page.getByRole('button', {name:'编辑监控：IPv6 出口'}).click()
      const pingEditor = page.getByRole('dialog')
      await pingEditor.getByRole('button', {name:'全选',exact:true}).click()
      assert.equal(await pingEditor.getByRole('checkbox', {checked:true}).count(), nodes.length)
      await pingEditor.getByRole('button', {name:'清空',exact:true}).click()
      assert.equal(await pingEditor.getByRole('checkbox', {checked:true}).count(), 0)
      page.once('dialog', d => d.accept())
      await pingEditor.getByRole('button', {name:'取消',exact:true}).click()
      await pingEditor.waitFor({state:'hidden'})

      await page.goto(origin+'/clara/data')
      await page.getByRole('heading',{name:'自动备份',exact:true}).waitFor()
      await page.getByText('最近 7 份及最近 7 个备份日期的每日副本',{exact:true}).waitFor()
      await page.getByText('每天 03:20，最多延后 10 分钟',{exact:true}).waitFor()
      await page.getByText('2026-11-11 03:21:27 CST',{exact:true}).waitFor()
      await page.getByText('未配置，目前仅保存在本机',{exact:true}).waitFor()
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({animations:'disabled',path:path.join(output,'backup-mobile.png'),fullPage:true})
      await page.setViewportSize({width:1440,height:1000})
      await page.screenshot({animations:'disabled',path:path.join(output,'backup-desktop.png'),fullPage:true})
      backupState='inactive'
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('已停用',{exact:true}).waitFor()
      assert.equal(await page.getByText('2026-11-11 03:21:27 CST',{exact:true}).count(),0,'stopped timer cannot retain a stale next run')
      backupFail=true
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('加载失败：模拟备份状态加载失败').waitFor()
      await page.getByText('最近 7 份及最近 7 个备份日期的每日副本',{exact:true}).waitFor()
      backupFail=false; backupState='unavailable'; backupError='模拟备份失败'; backupStale=true
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('无法确认定时任务状态',{exact:true}).waitFor()
      await page.getByRole('alert').filter({hasText:'最近备份失败：模拟备份失败'}).waitFor()
      await page.getByRole('alert').filter({hasText:'备份状态尚未上报或已过期'}).waitFor()
      backupState='active'; backupError=''; backupStale=false
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('已启用',{exact:true}).waitFor()
      await page.getByRole('button',{name:'导入备份',exact:true}).waitFor()
      await page.locator('input[type=file]').setInputFiles({name:'isolated.db',mimeType:'application/octet-stream',buffer:Buffer.from('fixture upload only')})
      await page.getByRole('button',{name:'确认恢复',exact:true}).click()
      await page.getByRole('status',{name:'备份恢复结果'}).waitFor()
      await page.clock.fastForward(16000)
      await page.getByRole('button',{name:'登录',exact:true}).waitFor()
      assert.match(restoreId,/^[a-f0-9]{32}$/)
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('cmonitor-restore')),restoreId,'lost response preserves operation ID')
      await page.reload()
      await page.getByRole('status',{name:'备份恢复结果'}).waitFor()
      restorePhase='complete'
      await page.clock.fastForward(3000)
      await page.getByText('数据库已恢复，恢复前副本已保留。所有登录已撤销，请重新登录。',{exact:true}).waitFor()
      await page.screenshot({animations:'disabled',path:path.join(output,'restore-result.png')})
      await page.getByRole('button',{name:'关闭恢复提示',exact:true}).click()
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('cmonitor-restore')),null)
      assert.equal(writes.filter(w=>w.pathname.endsWith('/apply')).length,1,'never auto-resubmit a restore')
      authed=true
    } else {
      await page.goto(origin+'/')
      await page.getByText('全部在线',{exact:true}).waitFor()
      await page.getByRole('button',{name:'关闭访客信息',exact:true}).waitFor()
      await page.screenshot({animations:"disabled",path:path.join(output,'status-desktop.png')})
      await page.setViewportSize({width:390,height:844})
      const footer=page.locator('aside').last()
      assert.equal(await footer.evaluate(el=>getComputedStyle(el).position),'static')
      await page.getByRole('button',{name:'关闭访客信息',exact:true}).click()
      await page.reload()
      assert.equal(await page.getByRole('button',{name:'关闭访客信息',exact:true}).count(),0)
      await page.getByText('全部在线',{exact:true}).waitFor()
      await page.screenshot({animations:"disabled",path:path.join(output,'status-mobile.png')})
      await page.goto(origin+`/node/${nodes[0].id}`)
      await page.getByRole('heading',{name:nodes[0].name,exact:true}).waitFor()
      await page.getByRole('button',{name:'刷新图表',exact:true}).waitFor()
      const before=historyCalls.length
      await page.clock.fastForward(65000)
      await page.waitForTimeout(100)
      assert(historyCalls.length>before,'visible history refreshes without changing tabs')
      const auto=historyCalls.length
      await page.getByRole('button',{name:'刷新图表',exact:true}).click()
      await page.waitForTimeout(100)
      assert(historyCalls.length>auto,'manual history refresh works')
      await page.clock.resume()
    }
    await page.goto(origin+(mode==='admin'?'/clara/nodes':'/'))
    await page.getByText(/实时更新/).waitFor()
    outage=true
    for (const ws of sockets) ws.close()
    await page.clock.fastForward(17000)
    await page.getByText(/数据更新中断/).waitFor()
    if(mode==='theme') assert.equal(await page.getByText('全部在线',{exact:true}).count(),0)
    await page.screenshot({animations:"disabled",path:path.join(output,`${mode}-outage.png`)})
    outage=false
    await page.clock.fastForward(6000)
    await page.getByText(/数据更新中断/).waitFor({state:'hidden'})
    // Regression for independently stale probes and ratios beyond their quota.
    if (mode === 'theme') {
      for (const node of nodes) {
        node.traffic_limit=1000; node.month_rx=1250; node.month_tx=250
        Object.assign(node.pings[0],{status:'stale',latency:null,last_latency:1,updated_at:Math.floor(Date.now()/1000)-3600})
      }
      await page.goto(origin+'/')
      await page.getByText('探测未更新',{exact:true}).first().waitFor()
      assert.equal(await page.getByText('150%',{exact:true}).count(),nodes.length)
      await page.getByLabel('搜索节点名称或标签').fill('无匹配的节点')
      await page.getByRole('button',{name:'清除筛选',exact:true}).click()
      await page.getByRole('heading',{name:nodes[0].name,exact:true}).waitFor()
    }
    // A denied Storage API must not blank either app (including restore status).
    await context.addInitScript(()=>{
      Storage.prototype.getItem=()=>{throw new DOMException('blocked','SecurityError')}
      Storage.prototype.setItem=()=>{throw new DOMException('blocked','SecurityError')}
    })
    await page.reload()
    await page.getByText(nodes[0].name,{exact:true}).filter({visible:true}).first().waitFor()
    await page.getByRole('button',{name:'切换主题',exact:true}).click()
    const pending=await context.newPage()
    await pending.route('**/api/me',()=>{})
    await pending.clock.install()
    await pending.goto(origin+(mode==='admin'?'/clara/nodes':'/'))
    await pending.getByText('加载中…',{exact:true}).waitFor()
    await pending.clock.fastForward(16000)
    await pending.getByRole('button',{name:'重试',exact:true}).waitFor()
    await pending.close()
    assert.deepEqual(errors,[],'no browser runtime errors')
    fs.writeFileSync(path.join(output,`${mode}-results.json`),JSON.stringify({mode,passed:true,writes,historyRequests:historyCalls.length},null,2))
    console.log(`${mode}: labels, error recovery, data freshness, responsive controls and refresh checks passed`)
  } finally {
    for (const timer of timers) clearInterval(timer)
    await browser.close()
    await new Promise(resolve=>server.close(resolve))
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
