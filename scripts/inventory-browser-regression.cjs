/* Exercise the production admin bundle. Chromium owns the sockets, fetches and
 * timers. Test routes control only the Hub responses and their arrival order. */
const assert = require('node:assert/strict')
const path = require('node:path')
const {setTimeout: delay} = require('node:timers/promises')
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '../web-admin/node_modules/playwright')

async function until(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + description)
    await delay(10)
  }
}

const origin = 'https://hub.example.test'
const dist = path.resolve(process.env.UX_DIST || path.join(__dirname, '../web-admin/dist'))
const node = name => ({
  id: 1, name, sort: 0, agent_version: '1.2.0', online: true, public: true, country: '', metrics: null,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, price: 0, billing_cycle: '', traffic_limit: 0,
  os: '', tags: '', ip: '', ipv4: '', ipv6: '',
})
const full = (seq, name) => ({admin: true, seq, nodes: [node(name)]})
const patch = (base, seq, name) => ({base, seq, patch: [{id: 1, set: {name}}]})
async function visibility(page, hidden) {
  await page.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', {configurable: true, value: hidden})
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function run() {
  const browser = await chromium.launch({headless: true, ...(process.env.UX_BROWSER_CHANNEL ? {channel: process.env.UX_BROWSER_CHANNEL} : {})})
  try {
    const page = await browser.newPage({viewport: {width: 1300, height: 900}, locale: 'zh-CN'})
    page.setDefaultTimeout(5000)
    const errors = [], connections = []
    let inventoryReads = 0, sessionChecks = 0, logins = 0, authed = true
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(() => {
      // Hold a fully received HTTP body until a later socket has delivered a
      // newer baseline. Aborting the network can no longer discard this result.
      const fetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await fetch(...args)
        if (response.headers.get('x-delay-body') === '1') {
          const payload = await response.json()
          response.json = () => new Promise(resolve => {
            window.releaseInventoryBody = () => resolve(payload)
          })
        }
        return response
      }
    })
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      assert.equal(url.origin, origin)
      if (url.pathname === '/api/nodes') {
        assert.equal(url.searchParams.get('view'), 'inventory')
        inventoryReads++
        return route.fulfill({
          headers: inventoryReads === 2 ? {'x-delay-body': '1'} : {},
          json: {admin: true, nodes: [node(inventoryReads === 2 ? 'Late HTTP' : 'HTTP fallback')]},
        })
      }
      if (url.pathname === '/api/me') return route.fulfill({json: {authed, site_name: 'Test', password_login: true}})
      if (url.pathname === '/api/auth/session') {
        sessionChecks++
        return route.fulfill({status: authed ? 204 : 401})
      }
      if (url.pathname === '/api/auth/login') {
        assert.equal(route.request().method(), 'POST')
        authed = true
        logins++
        return route.fulfill({json: {}})
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({json: {}})
      const asset = url.pathname.startsWith('/clara/assets/') ? url.pathname.slice('/clara/'.length)
        : url.pathname.endsWith('favicon.svg') ? 'favicon.svg' : 'index.html'
      return route.fulfill({path: path.join(dist, asset)})
    })
    await page.routeWebSocket('**/api/ws*', ws => {
      const url = new URL(ws.url())
      assert.equal(url.searchParams.get('view'), 'inventory')
      assert.equal(url.searchParams.get('format'), 'delta-v1')
      const socket = {closed: false, send: data => ws.send(JSON.stringify(data))}
      ws.onClose(() => { socket.closed = true })
      connections.push(socket)
    })
    const connection = async index => {
      await until(() => connections.length > index, 'inventory socket ' + index)
      return connections[index]
    }
    const visible = label => page.getByText(label, {exact: true}).filter({visible: true}).first()
    const navigate = route => page.locator('a[href="/clara/' + route + '"]').filter({visible:true}).first().click()
    await page.clock.install()
    await page.goto(origin + '/clara/nodes')

    const first = await connection(0)
    first.send(full(20, 'First baseline'))
    await visible('First baseline').waitFor()
    await page.clock.fastForward(6000)
    first.send(patch(20, 21, 'Patched name'))
    await visible('Patched name').waitFor()
    assert.equal(inventoryReads, 0, 'a healthy socket supplies the initial list and subsequent edits')

    first.send(patch(19, 22, 'Wrong sequence'))
    await visible('HTTP fallback').waitFor()
    assert.equal(inventoryReads, 1)
    assert.equal(await visible('Wrong sequence').count(), 0)
    await until(() => first.closed, 'gapped socket to close')
    await page.clock.fastForward(5200)
    const second = await connection(1)
    // Neither the previous socket nor the fallback is a base for this socket.
    second.send(patch(21, 22, 'Wrong socket base'))
    await until(() => second.closed, 'socket without a baseline to close')
    await page.waitForFunction(() => typeof window.releaseInventoryBody === 'function')
    await page.clock.fastForward(5200)
    const recovered = await connection(2)
    recovered.send(full(80, 'Reconnected'))
    await visible('Reconnected').waitFor()
    await page.evaluate(() => window.releaseInventoryBody())
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await visible('Reconnected').waitFor()
    assert.equal(await visible('Late HTTP').count(), 0, 'completed HTTP must not overwrite a new live baseline')
    recovered.send(patch(80, 81, 'After recovery'))
    await visible('After recovery').waitFor()

    await visibility(page, true)
    await until(() => recovered.closed, 'hidden page to disconnect')
    const hiddenReads = inventoryReads
    await page.clock.fastForward(30000)
    assert.equal(connections.length, 3)
    assert.equal(inventoryReads, hiddenReads)
    await visibility(page, false)
    const resumed = await connection(3)
    resumed.send(full(100, 'Visible again'))
    await visible('Visible again').waitFor()
    await navigate('settings')
    await until(() => resumed.closed, 'leaving inventory to disconnect')
    await page.clock.fastForward(16000)
    await until(() => sessionChecks > 0, 'settings session check')
    assert.equal(connections.length, 4)
    assert.equal(inventoryReads, hiddenReads, 'settings only check the session')
    await visibility(page, true)
    const checksBeforeHidden = sessionChecks
    await page.clock.fastForward(31000)
    assert.equal(sessionChecks, checksBeforeHidden, 'hidden settings do not poll')
    authed = false
    await visibility(page, false)
    await page.getByRole('heading', {name:'登录后台'}).waitFor()
    assert.equal(sessionChecks, checksBeforeHidden + 1)
    assert.equal(await visible('Visible again').count(), 0)
    await page.getByLabel('应急密码').fill('fixture')
    await page.getByRole('button', {name:'登录',exact:true}).click()
    await page.locator('a[href="/clara/nodes"]').filter({visible:true}).first().waitFor()
    assert.equal(logins, 1)
    assert.equal(connections.length, 4, 'logging back in on settings does not subscribe')
    await navigate('nodes')
    const signedIn = await connection(4)
    signedIn.send(full(1, 'New session'))
    await visible('New session').waitFor()
    assert.equal(await visible('Visible again').count(), 0)
    assert.deepEqual(errors, [])
    console.log('Admin inventory: deltas, recovery, HTTP races, visibility, routes and reauthentication passed.')
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
