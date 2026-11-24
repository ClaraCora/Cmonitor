/* All page assets come from the local build; requests and writes are intercepted. */
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../web-admin/node_modules/playwright')

async function run() {
  const dist = path.resolve(process.env.UX_DIST || path.join(__dirname, '../web-admin/dist'))
  const browser = await chromium.launch({ headless: true, ...(process.env.UX_BROWSER_CHANNEL ? { channel: process.env.UX_BROWSER_CHANNEL } : {}) })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    const origin = 'https://hub.example.test'
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      id: index + 1, name: `节点 ${index + 1}`, sort: index, agent_version: '1.0.0', online: false,
      country: '', metrics: null, public: true, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
      price: 0, billing_cycle: '', traffic_limit: 0, ip: '', ipv4: '', ipv6: '', os: '', tags: '',
    }))
    const states = { 1: 'current', 2: 'ready', 3: 'plaintext', 4: 'ready', 5: 'ready', 6: 'ready', 7: 'ready' }
    nodes[0].online = true
    nodes[0].agent_version = '1.2.2'
    nodes[0].terminal_reason = 'available'
    nodes[1].online = true
    nodes[2].offline_only = true
    nodes[3].online = true
    const pairing = { 1: 'unpaired', 2: 'paired', 3: 'offline_only', 4: 'unpaired', 7: 'unpaired' }
    const pairingWrites = []
    const ticket = n => 'fixture-only-pair-command-' + n
    let pairError = false
    const command = "sh /root/agent-offline-install.sh '" + 'a'.repeat(64) + "' 'http://fixture.test/agent-v1.2.2.tar.gz'"
    const commandReads = []
    let commandAvailable = true
    let workers
    let batch = { id: 42, target: '1.2.1', status: 'running', reason: '', items: [{ node: 1, status: 'observing' }] }
    let failRead = true
    let terminalAllowed = false
    let terminalConnections = 0
    let passwordChecks = 0
    const writes = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      const pathname = url.pathname
      if (pathname === '/api/terminal/access') {
        return route.fulfill({ json: { allowed: terminalAllowed, github: true, password_login: true } })
      }
      if (pathname === '/api/auth/login') {
        assert.equal(route.request().method(), 'POST')
        passwordChecks++
        terminalAllowed = true
        return route.fulfill({ json: {} })
      }
      if (pathname.endsWith('/maintenance/pair-command')) {
        assert.equal(route.request().method(), 'POST')
        assert.equal(pathname, '/api/nodes/1/maintenance/pair-command')
        pairingWrites.push(pathname)
        const expires_at = await page.evaluate(() => Math.floor(Date.now() / 1000) + 600)
        return pairError
          ? route.fulfill({ status: 403, body: 'reauthenticate' })
          : route.fulfill({ json: { command: ticket(pairingWrites.length), expires_at } })
      }
      if (pathname.endsWith('/offline-upgrade-command')) {
        commandReads.push([route.request().method(), pathname])
        assert.equal(pathname, '/api/nodes/3/offline-upgrade-command')
        return commandAvailable
          ? route.fulfill({ json: { command, version: '1.2.2' } })
          : route.fulfill({ status: 409, body: '请先配置该版本的离线包' })
      }
      if (pathname === '/api/agent-upgrades') {
        if (route.request().method() === 'POST') {
          writes.push(route.request().postDataJSON())
          batch = { id: 43, target: '1.2.1', status: 'running', reason: '', items: [
            { node: 2, status: 'ready' }, { node: 4, status: 'queued' }, { node: 6, status: 'queued' },
          ] }
          // The Hub accepted the write but its HTTP response was lost.
          return route.abort('connectionreset')
        }
        return failRead ? route.fulfill({ status: 503, body: '模拟暂时中断' }) : route.fulfill({ json: { target: '1.2.1', nodes: states, batch, workers, maintenance: workers ? pairing : undefined } })
      }
      if (pathname === '/api/me') return route.fulfill({ json: { authed: true, site_name: 'Cmonitor' } })
      if (pathname === '/api/nodes') return route.fulfill({ json: { nodes, admin: true } })
      if (pathname.startsWith('/api/')) return route.fulfill({ json: {} })
      const asset = pathname === '/clara/nodes' ? 'index.html' : pathname.slice('/clara/'.length)
      return route.fulfill({ path: path.join(dist, asset) })
    })
    await page.routeWebSocket(/\/api\/ws(?:\?|$)/, ws => ws.send(JSON.stringify({ nodes, admin: true })))
    await page.routeWebSocket('**/api/terminal/ws', ws => {
      terminalConnections++
      ws.onMessage(message => {
        if (JSON.parse(message.toString()).type === 'connect') ws.send(JSON.stringify({ method: 'terminal.ready' }))
      })
    })
    await page.clock.install()
    await page.goto(origin + '/clara/nodes')
    await page.setViewportSize({ width: 1280, height: 900 })
    const openTerminal = page.getByRole('button', { name: /打开 Web Terminal/ }).first()
    await openTerminal.click()
    const gate = page.getByRole('dialog', { name: '确认终端访问身份' })
    await gate.getByText(/最近 10 分钟/).waitFor()
    assert.equal(terminalConnections, 0, 'an enabled GitHub provider alone does not authorize the socket')
    await gate.getByLabel('应急密码').fill('fixture-only')
    await gate.getByRole('button', { name: '认证并打开终端' }).click()
    const live = page.getByRole('dialog', { name: '节点 1 · Web Terminal' })
    await live.getByText('已连接', { exact: true }).waitFor()
    assert.equal(passwordChecks, 1)
    await page.keyboard.press('Escape')
    await live.waitFor({ state: 'hidden' })
    // An eligible session is approved on opening; no intermediate sign-in or POST.
    await openTerminal.click()
    await live.getByText('已连接', { exact: true }).waitFor()
    assert.equal(terminalConnections, 2)
    assert.equal(passwordChecks, 1)
    await page.keyboard.press('Escape')
    await live.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    const copy = page.getByRole('button', { name: '复制升级命令', exact: true })
    assert.equal(commandReads.length, 0, 'rendering and receiving node data do not fetch a command')
    await copy.waitFor()
    assert.equal(await copy.count(), 1, 'only the explicitly offline-maintained node has a visible copy action')
    await copy.click()
    await page.getByText('已复制 节点 3 的升级命令').waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command)
    assert.deepEqual(writes, [], 'copying does not start an upgrade')
    await page.setViewportSize({ width: 1280, height: 900 })
    assert.equal(await page.getByRole('row').filter({ hasText: '节点 3' }).getByRole('button', { name: '复制升级命令' }).count(), 1)
    await page.evaluate(() => {
      for (const method of ['write', 'writeText']) {
        Object.defineProperty(navigator.clipboard, method, { configurable: true, value: async () => {
          throw new DOMException('Clipboard blocked in test', 'NotAllowedError')
        } })
      }
    })
    await copy.click()
    const fallback = page.getByRole('dialog', { name: '节点 3 · 手动复制升级命令' })
    const text = fallback.getByRole('textbox', { name: 'Agent v1.2.2 升级命令' })
    await fallback.getByText(/通过独立 SSH 登录此节点/).waitFor()
    assert.equal(await text.inputValue(), command)
    await fallback.getByRole('button', { name: '全选命令' }).click()
    assert.deepEqual(await text.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, command.length])
    await fallback.getByRole('button', { name: '关闭', exact: true }).click()
    await fallback.waitFor({ state: 'hidden' })
    await page.clock.runFor(50) // Radix restores focus on the next timer tick.
    assert(await copy.evaluate(el => el === document.activeElement))
    await page.setViewportSize({ width: 390, height: 844 })
    commandAvailable = false
    await copy.click()
    await page.getByText('请先配置该版本的离线包').waitFor()
    assert.equal(await fallback.count(), 0, 'failed GET must not offer an old command')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    commandAvailable = true
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
    const offlineChoice = dialog.getByRole('checkbox', { name: /节点 3/ })
    const rowCopy = dialog.getByRole('button', { name: '复制升级命令' })
    await rowCopy.click()
    await fallback.waitFor()
    assert.equal(await text.inputValue(), command)
    assert.equal(await fallback.evaluate(el => el.scrollWidth > el.clientWidth), false)
    await fallback.getByRole('button', { name: '关闭', exact: true }).click()
    assert.equal(await offlineChoice.isChecked(), false)
    assert.deepEqual(commandReads, Array(4).fill(['GET', '/api/nodes/3/offline-upgrade-command']))
    assert.deepEqual(writes, [])
    const maint = dialog.getByText('管理节点维护凭据', { exact: true })
    const picker = dialog.getByRole('combobox', { name: '维护凭据所属节点' })
    const issue = dialog.getByRole('button', { name: '复制一次性配对命令', exact: true })
    const reissue = dialog.getByRole('button', { name: '重新生成并复制', exact: true })
    const secret = dialog.getByRole('textbox', { name: '节点 1 的一次性配对命令' })
    await maint.click()
    for (const id of ['2', '3', '7']) {
      await picker.selectOption(id)
      assert.equal(await issue.count(), 0, 'paired, offline-only and disconnected nodes do not offer pairing')
    }
    await picker.selectOption('1')
    await issue.waitFor()
    await page.clock.fastForward(3500)
    assert.equal(pairingWrites.length, 0, 'selection and refreshing do not issue tickets')
    await issue.click()
    await secret.waitFor()
    assert.equal(await secret.inputValue(), ticket(1))
    await dialog.getByRole('button', { name: '全选配对命令' }).click()
    assert.deepEqual(await secret.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, ticket(1).length])
    assert.equal(pairingWrites.length, 1, 'permission denial and manual selection reuse the issued command')
    await dialog.getByRole('button', { name: '隐藏并清除命令' }).click()
    assert.equal(await secret.count(), 0)
    await reissue.click()
    await secret.waitFor()
    assert.equal(await secret.inputValue(), ticket(2))
    await maint.click()
    await maint.click()
    await issue.waitFor()
    assert.equal(await secret.count(), 0, 'collapsing unmounts any rendered ticket')
    await issue.click()
    await secret.waitFor()
    await picker.selectOption('4')
    await picker.selectOption('1')
    assert.equal(await secret.count(), 0, 'changing nodes discards the first ticket')
    await issue.click()
    await secret.waitFor()
    await page.clock.fastForward(601_000)
    await dialog.getByText('配对命令已过期，可以重新生成。').waitFor()
    assert.equal(await secret.count(), 0, 'an expired ticket is removed')
    pairError = true
    await issue.click()
    await dialog.getByText(/当前会话无法生成配对命令/).waitFor()
    assert.equal(await secret.count(), 0)
    pairError = false
    await page.evaluate(() => {
      delete navigator.clipboard.writeText
      delete navigator.clipboard.write
    })
    await issue.click()
    await dialog.getByText(/已复制。失效时间/).waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ticket(6))
    assert.equal(await secret.count(), 0, 'successful copying does not display the credential')
    pairing[1] = 'paired'
    await page.clock.fastForward(3500)
    await dialog.getByText('已配对，等待升级器 v2 的新心跳').waitFor()
    workers[1] = { protocol: 2, last_seen: await page.evaluate(() => Math.floor(Date.now() / 1000)) }
    await page.clock.fastForward(3500)
    await dialog.getByText('已收到升级器 v2 心跳').waitFor()
    assert.equal(await issue.count() + await reissue.count(), 0)
    assert.equal(pairingWrites.length, 6)
    await maint.click()
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
    console.log('Offline commands and upgrade dialog passed: clipboard, manual fallback, read-only requests, polling, retry selection and rollback.')
  } finally { await browser.close() }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
