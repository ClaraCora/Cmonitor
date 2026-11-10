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
const nodes = [1, 2].map(id => ({ id, name: `测试节点 ${id}`, sort: id, public: true, online: true, country: 'SG', last_seen: Math.floor(Date.now()/1000), metrics: metric, hostname: 'fixture', ip: `198.51.100.${id}`, ipv4: '', ipv6: '', os: 'Linux', kernel: '', arch: 'x86_64', virt: 'kvm', cpu_name: 'Test CPU', cpu_cores: 2, mem_total: 1024, swap_total: 0, disk_total: 2048, agent_version: '1.2.0', price: 5, currency: 'USD', billing_cycle: 'monthly', expires_at: '2026-12-10', permanent: false, traffic_limit: 1024**3, traffic_mode: 'sum', traffic_reset_day: 1, total_rx: 1000, total_tx: 2000, month_rx: 100, month_tx: 200, month_start: '2026-11-01', day_rx: 10, day_tx: 20, traffic_incomplete: false, token: 'fixture-only', notify: true, muted_until: 0, remark: '', tags: '', website: 'https://example.com', pings: [{id: 1, name: '测试探测', latency: 20, updated_at: Math.floor(Date.now()/1000), samples: [20,21,19]}] }))
const settings = { site_name: 'Monitor', retention_days: '7', public_page: 'on', visitor_card: 'on', notify_grace: '3', notify_traffic: '80', notify_expiry: '7', notify_disk_percent: '90', notify_disk_minutes: '10', notify_ping_failures: '3', notify_cooldown: '60', notify_login: 'on', notify_telegram_chat: '', notify_telegram_text: '{{title}}', notify_webhook_body: '{"text":"{{message}}"}', password_login: 'on' }
const me = { authed: true, github: false, password_login: true, hub_version: 'test', site_name: 'Monitor', public_page: true, site: 'https://monitor.example.com', can_provision: true, admin_url: '/clara/nodes', visitor_card: true }

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
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ headless: true, ...(process.env.UX_BROWSER_CHANNEL ? { channel: process.env.UX_BROWSER_CHANNEL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', hasTouch: true })
  let settingsFail = false, pingFail = false, outage = false, authed = true, restorePhase = 'applying', restoreId = ''
  let backupState = 'active', backupFail = false, backupError = ''
  const sockets = new Set(), timers = new Set(), writes = [], historyCalls = []
  const errors = []
  try {
    await context.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname
      const fail = body => route.fulfill({status:503,body})
      if (outage && pathname === '/api/nodes') return fail('模拟网络中断')
      if (settingsFail && pathname === '/api/settings') return fail('模拟设置加载失败')
      if (pingFail && pathname === '/api/ping-tasks') return fail('模拟探测加载失败')
      if (backupFail && pathname === '/api/db') return fail('模拟备份状态加载失败')
      if (req.method() !== 'GET') {
        writes.push({ pathname, method:req.method(), body:req.postData() })
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
      else if (pathname === '/api/db') data = {path:'fixture.db',size:1024,wal:0,free:0,oldest:null,retention:7,rows:{},backup_success:'1794280900',backup_error:backupError,scheduled_backup:{scheduler:{state:backupState,boot_enabled:true,calendar:'*-*-* 03:20:00',random_delay:'10min',next_run:backupState==='active'?'Wed 2026-11-11 03:21:27 CST':null},policy:{directory:'/opt/monitor/backups',keep:7,offsite:false},copies:1,checked_at:1794280900,timezone:'UTC+08:00'}}
      else if (/^\/api\/db\/restore\/[a-f0-9]{32}$/.test(pathname)) data = {phase:restorePhase}
      else if (pathname === '/api/settings') data = settings
      else if (pathname.endsWith('/metrics')) {
        historyCalls.push(req.url())
        const now=Math.floor(Date.now()/1000)
        data={metrics:[{ts:now-60,cpu:5,mem_used:128,disk_used:256,net_rx:10,net_tx:20},{ts:now,cpu:6,mem_used:130,disk_used:256,net_rx:20,net_tx:20}],ping:[{task_id:1,ts:now-60,latency:20},{task_id:1,ts:now,latency:21}],probes:{1:'测试探测'},loss:{}}
      }
      else if (pathname === '/api/ping-tasks') data={tasks:[]}
      else if (pathname === '/api/visitor-log') data={visits:[]}
      else if (pathname === '/api/visitor') data={ip:'198.51.100.99',city:'测试地区',country:'CN'}
      else if (pathname.endsWith('/renewals')) data={history:[]}
      else if (pathname === '/api/notify/history') data={items:[]}
      else if (pathname === '/api/sessions') data=[]
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
    })
    await context.routeWebSocket('**/api/ws', ws => {
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
      await page.goto(origin+'/clara/nodes')
      await page.getByRole('button',{name:'编辑节点',exact:true}).first().click()
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
      await page.getByRole('button',{name:`${nodes[0].name} 更多操作`,exact:true}).tap()
      await page.getByRole('menuitem',{name:'下移',exact:true}).tap()
      assert(writes.some(w=>w.pathname==='/api/nodes/order'),'mobile sorting uses explicit controls')
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({animations:"disabled",path:path.join(output,'admin-mobile.png')})
      settingsFail=true
      await page.goto(origin+'/clara/settings')
      await page.getByRole('button',{name:'重新加载',exact:true}).click()
      await page.getByText('加载失败：模拟设置加载失败').waitFor()
      settingsFail=false
      await page.getByRole('button',{name:'重新加载',exact:true}).click()
      await page.getByLabel('站点名称',{exact:true}).waitFor()
      await page.getByRole('button',{name:'退出登录',exact:true}).click()
      await page.getByText('退出失败，请重试',{exact:true}).waitFor()
      assert(page.url().endsWith('/clara/settings'),'failed logout must not navigate')
      pingFail=true
      await page.goto(origin+'/clara/ping')
      await page.getByText('加载失败：模拟探测加载失败').waitFor()
      assert.equal(await page.getByText('还没有延迟监控。',{exact:false}).count(),0)

      await page.goto(origin+'/clara/data')
      await page.getByRole('heading',{name:'自动备份',exact:true}).waitFor()
      await page.getByText('最近 7 份成功备份',{exact:true}).waitFor()
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
      await page.getByText('最近 7 份成功备份',{exact:true}).waitFor()
      backupFail=false; backupState='unavailable'; backupError='模拟备份失败'
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('无法确认定时任务状态',{exact:true}).waitFor()
      await page.getByRole('alert').filter({hasText:'最近备份失败：模拟备份失败'}).waitFor()
      backupState='active'; backupError=''
      await page.getByRole('button',{name:'刷新备份状态',exact:true}).click()
      await page.getByText('已启用',{exact:true}).waitFor()
      await page.getByRole('button',{name:'导入备份',exact:true}).waitFor()
      await page.locator('input[type=file]').setInputFiles({name:'isolated.db',mimeType:'application/octet-stream',buffer:Buffer.from('fixture upload only')})
      await page.getByRole('button',{name:'确认恢复',exact:true}).click()
      await page.getByRole('status',{name:'备份恢复结果'}).waitFor()
      await page.clock.fastForward(6000)
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
