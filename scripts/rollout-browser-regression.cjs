/* All page assets come from the local build; requests and writes are intercepted. */
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../web-admin/node_modules/playwright')

async function run() {
  const dist = path.resolve(process.env.UX_DIST || path.join(__dirname, '../web-admin/dist'))
  const browser = await chromium.launch({ headless: true, ...(process.env.UX_BROWSER_CHANNEL ? { channel: process.env.UX_BROWSER_CHANNEL } : {}) })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    const origin = 'http://127.0.0.1:4173'
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1, name: `节点 ${index + 1}`, sort: index, agent_version: '1.0.0', online: false,
      country: '', metrics: null, public: true, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
      price: 0, billing_cycle: '', traffic_limit: 0, ip: '', ipv4: '', ipv6: '', os: '', tags: '',
    }))
    const states = { 1: 'current', 2: 'ready', 3: 'plaintext', 4: 'ready', 5: 'ready', 6: 'ready', 7: 'ready' }
    let workers
    let batch = { id: 42, target: '1.2.1', status: 'running', reason: '', items: [{ node: 1, status: 'observing' }] }
    let failRead = true
    const writes = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      const pathname = url.pathname
      if (pathname === '/api/agent-upgrades') {
        if (route.request().method() === 'POST') {
          writes.push(route.request().postDataJSON())
          batch = { id: 43, target: '1.2.1', status: 'running', reason: '', items: [
            { node: 2, status: 'ready' }, { node: 4, status: 'queued' }, { node: 6, status: 'queued' },
          ] }
          // The Hub accepted the write but its HTTP response was lost.
          return route.abort('connectionreset')
        }
        return failRead ? route.fulfill({ status: 503, body: '模拟暂时中断' }) : route.fulfill({ json: { target: '1.2.1', nodes: states, batch, workers } })
      }
      if (pathname === '/api/me') return route.fulfill({ json: { authed: true, site_name: 'Cmonitor' } })
      if (pathname === '/api/nodes') return route.fulfill({ json: { nodes, admin: true } })
      if (pathname.startsWith('/api/')) return route.fulfill({ json: {} })
      const asset = pathname === '/clara/nodes' ? 'index.html' : pathname.slice('/clara/'.length)
      return route.fulfill({ path: path.join(dist, asset) })
    })
    await page.routeWebSocket('**/api/ws', ws => ws.send(JSON.stringify({ nodes, admin: true })))
    await page.clock.install()
    await page.goto(origin + '/clara/nodes')
    const trigger = page.getByRole('button', { name: '升级 Agent', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    const recent = dialog.getByRole('region', { name: '最近批次' })
    const submit = dialog.getByRole('button', { name: /开始升级/ })
    await dialog.getByText(/无法读取节点状态/).waitFor()
    assert.equal(await dialog.getByText(/正在读取节点状态/).count(), 0)

    failRead = false
    await dialog.getByRole('button', { name: '重新读取' }).click()
    await recent.getByText(/批次 #42/).waitFor()
    // Older Hubs send only node and status; no empty timestamps or reasons.
    await recent.getByText('等待新版重新上报').waitFor()
    await dialog.getByText('查看各节点升级器').click()
    assert.equal(await dialog.getByText('升级器协议未记录', { exact: true }).count(), nodes.length)
    assert.equal(await recent.getByText(/截止|更新于/).count(), 0)
    assert.equal(await submit.count(), 0)

    failRead = true
    await page.clock.fastForward(3200)
    await dialog.getByText(/刷新失败，显示上次读取的状态/).waitFor()
    assert(await recent.getByText(/批次 #42/).isVisible())
    failRead = false
    workers = { 1: { protocol: 2, last_seen: 1730000010 }, 2: { protocol: 1, last_seen: 1730000005 } }
    batch = { ...batch, status: 'stopped', reason: '一台节点升级超时', items: [
      { node: 1, status: 'verified' },
      { node: 2, status: 'failed', reason: '校验失败', updated_at: 1730000000 },
      { node: 3, status: 'skipped' }, // HTTP
      { node: 4, status: 'skipped' },
      { node: 5, status: 'unconfirmed' },
      { node: 6, status: 'rolled_back', reason: '已切换回旧版本' },
    ] }
    await page.clock.fastForward(3200)
    await recent.getByText('校验失败').waitFor()
    await recent.getByText('已切换回旧版本').waitFor()
    await recent.getByText(/更新于/).waitFor()
    assert.equal(await dialog.getByRole('alert').count(), 0)
    const current = dialog.getByRole('checkbox', { name: /节点 1 .*已达到目标版本.*升级器 v2.*最近心跳/ })
    assert(await current.isDisabled(), 'target-version nodes still show the protocol from their last heartbeat')
    assert(await dialog.getByRole('checkbox', { name: /节点 2 .*升级器 v1.*最近心跳/ }).isEnabled(), 'legacy workers remain selectable')
    assert(await dialog.getByRole('checkbox', { name: /节点 3 .*升级器协议未记录/ }).isDisabled())
    const retry = dialog.getByRole('button', { name: '选择可重试节点（3 台）' })
    await retry.click()
    await dialog.getByText('首台验证：节点 2').waitFor()
    assert.deepEqual(await dialog.locator('label:has(:checked) > span:first-of-type').allTextContents(), ['节点 2', '节点 4', '节点 6'])
    assert.deepEqual(writes, [], 'selecting candidates must not start a batch')
    failRead = true
    await page.clock.fastForward(3200)
    await dialog.getByText(/刷新失败/).waitFor()
    assert(await submit.isDisabled())
    assert(await retry.isDisabled())
    failRead = false
    await dialog.getByRole('button', { name: '重新读取' }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    assert(await submit.isEnabled())
    await submit.click()
    await recent.getByText(/批次 #43/).waitFor()
    await dialog.getByText(/未收到提交确认/).waitFor()
    await page.keyboard.press('Escape')
    await trigger.click()
    await recent.getByText(/批次 #43/).waitFor()
    await dialog.getByText(/正在更新上次读取/).waitFor({ state: 'hidden' })
    batch = { ...batch, reason: '等待旧版恢复', items: [
      { node: 2, status: 'rollback_pending', deadline: 1730000600 }, { node: 4, status: 'rolling_back' },
    ] }
    await page.clock.fastForward(3200)
    await recent.getByText('等候升级器领取回滚任务').waitFor()
    await recent.getByText('正在恢复旧版').waitFor()
    await recent.getByText(/截止/).waitFor()
    assert.deepEqual(writes, [{ nodes: [2, 4, 6] }])
    assert.deepEqual(errors, [])
    console.log('Upgrade dialog passed: legacy overview, polling recovery, retry selection, lost acknowledgement, ongoing rollback.')
  } finally { await browser.close() }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
