/**
 * The portable host.
 *
 * The app was written as Adobe I/O Runtime actions, but an action is already
 * just `(params) -> { statusCode, headers, body }`, which is HTTP with extra
 * steps. This file supplies the missing steps: a plain Node server that routes
 * a request to the right action and synthesizes the five `__ow_*` keys those
 * actions read.
 *
 * Nothing in actions/ or lib/ changed to make this work.
 *
 * The result runs anywhere a container runs — Cloud Run, ECS/Fargate, Lambda
 * (container image, behind the Web Adapter), Kubernetes, or a laptop. The
 * point is not that we picked a cloud; it is that we no longer have to.
 *
 *   PORT            default 8080 (Cloud Run and Lambda both pass this in)
 *   STORAGE_DRIVER  fs | s3 | gcs | aio   (see lib/storage)
 *   INTERNAL_TOKEN  guards the scheduled endpoints below
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { Core } = require('./lib/logger')

const logger = Core.Logger('server', { level: process.env.LOG_LEVEL })
const PORT = Number(process.env.PORT || 8080)
const WEB_ROOT = path.join(__dirname, 'web-src')
const EPHEMERAL_SERVICE_KEY = require('crypto').randomBytes(24).toString('hex')

/**
 * Path prefix -> action. These mirror the runtimeManifest the app used to
 * deploy with, so a URL that worked on the old host works here.
 */
const ROUTES = [
  ['/api/v1/web/tap-mcp-connector/mcp-server', () => require('./actions/mcp-server')],
  ['/api/v1/web/tap-mcp-connector/dashboard-api', () => require('./actions/dashboard-api')],
  ['/api/v1/web/tap-mcp-connector/oauth-bridge', () => require('./actions/oauth-bridge')],
  ['/api/v1/web/tap-mcp-connector/well-known', () => require('./actions/well-known')],
  ['/.well-known', () => require('./actions/well-known')],
  // Short aliases, because the old paths carry a package name we have outgrown.
  ['/mcp', () => require('./actions/mcp-server')],
  ['/dashboard-api', () => require('./actions/dashboard-api')],
  ['/oauth', () => require('./actions/oauth-bridge')],
  ['/mcp-connect', () => require('./actions/mcp-connect')]
]

/**
 * Jobs the old host ran on a cron trigger. As HTTP endpoints they can be
 * driven by Cloud Scheduler, EventBridge, a Kubernetes CronJob or curl —
 * which is the whole portability argument in miniature.
 */
const JOBS = {
  '/internal/purge': () => require('./actions/purge-scheduled'),
  '/internal/cx-refresh': () => require('./actions/cx-refresh-scheduled')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Adobe I/O declared each action's configuration as `inputs:` in
 * app.config.yaml, and the platform merged them into `params`. The actions
 * therefore read config from params, not from process.env - so a host that
 * only supplies __ow_* leaves every one of them undefined, and the dashboard
 * fails closed with "the proxy or upstream may be unavailable".
 *
 * This is that merge. The list mirrors app.config.yaml's inputs, enumerated
 * rather than spreading all of process.env, so nothing unrelated to the app
 * can reach an action's params (which get logged).
 */
const CONFIG_KEYS = [
  'LOG_LEVEL',
  'MCP_AUTH_MODE', 'AUTH_PROVIDER', 'BOOTSTRAP_ADMINS',
  'OIDC_ISSUER', 'OIDC_DISCOVERY_URL', 'OIDC_AUDIENCE',
  'OIDC_REQUIRED_SCOPE', 'OIDC_SCOPES',
  'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'OAUTH_ISSUER_URL',
  'SERVICE_API_KEY', 'API_KEY_OWNERS',
  'DASHBOARD_OAUTH_CLIENT_ID', 'DASHBOARD_PASSCODE', 'DASHBOARD_REQUIRE_IDENTITY',
  'MCP_RESOURCE_URL','MCP_CONNECT_REDIRECT_URI', 'MCP_PRM_URL', 'MCP_PACKAGE_NAME', 'MCP_OAUTH_BRIDGE_URL'
]

function configParams () {
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key]
  }
  // On Adobe I/O the dashboard proxy and the MCP server were separate actions on
  // separate URLs, so MCP_RESOURCE_URL had to be configured. Here they are the
  // same process, so point it at ourselves unless someone says otherwise.
  // Without this the dashboard answers every call with
  // "Proxy is not configured: MCP_RESOURCE_URL is unset".
  if (!out.MCP_RESOURCE_URL) out.MCP_RESOURCE_URL = `http://127.0.0.1:${PORT}/mcp`
  if (!out.MCP_PRM_URL) out.MCP_PRM_URL = `http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`
  // The dashboard proxy authenticates to the MCP server with a service key. On
  // Adobe those were two deployments and the key was real shared config; here
  // the hop is loopback inside one process, so a per-boot random value is both
  // sufficient and safer - it is never written down and never leaves the
  // container. Set SERVICE_API_KEY explicitly to override.
  if (!out.SERVICE_API_KEY) out.SERVICE_API_KEY = EPHEMERAL_SERVICE_KEY
  return out
}

/** Build the params object an action expects, from a Node request. */
function toParams (req, url, body, mountedAt) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v

  const query = {}
  for (const [k, v] of url.searchParams) query[k] = v

  // Actions that route internally (oauth-bridge, well-known) read the path
  // BELOW their own mount point, exactly as OpenWhisk gave it to them.
  const suffix = url.pathname.slice(mountedAt.length) || '/'

  return {
    ...configParams(),
    ...query,
    __ow_method: String(req.method || 'GET').toLowerCase(),
    __ow_headers: headers,
    __ow_path: suffix === '/' ? '' : suffix,
    __ow_query: url.search.replace(/^\?/, ''),
    __ow_body: body.length ? body.toString('utf8') : ''
  }
}

function send (res, result) {
  const status = result?.statusCode || 200
  const headers = { ...(result?.headers || {}) }
  let body = result?.body ?? ''
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body)
    headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8'
  }
  res.writeHead(status, headers)
  res.end(body)
}

/** Serve the SPA. Unknown paths fall back to index.html, as an SPA needs. */
function serveStatic (res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = path.join(WEB_ROOT, rel)
  if (!full.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('forbidden'); return
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      fs.readFile(path.join(WEB_ROOT, 'index.html'), (e2, index) => {
        if (e2) { res.writeHead(404); res.end('not found'); return }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, must-revalidate' })
        res.end(index)
      })
      return
    }
    // The SPA is one file that changes on every deploy. Without this a browser
    // keeps serving yesterday's copy, and a fix that is live on the server looks
    // like it did not work - which is worse than an obvious failure.
    const ext = path.extname(full)
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' }
    if (ext === '.html' || ext === '.js' || ext === '.json') {
      headers['Cache-Control'] = 'no-store, must-revalidate'
    }
    res.writeHead(200, headers)
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  try {
    // Liveness. Deliberately free of storage or auth so a platform health
    // check cannot be taken down by a misconfigured bucket.
    if (url.pathname === '/healthz') {
      return send(res, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, storage: process.env.STORAGE_DRIVER || 'fs' })
      })
    }

    const job = Object.keys(JOBS).find(p => url.pathname === p)
    if (job) {
      const expected = process.env.INTERNAL_TOKEN
      const given = req.headers['x-internal-token']
      if (!expected || given !== expected) {
        return send(res, { statusCode: 403, body: JSON.stringify({ error: 'forbidden' }) })
      }
      const result = await JOBS[job]().main(configParams())
      return send(res, { statusCode: 200, body: JSON.stringify(result || { ok: true }) })
    }

    const route = ROUTES.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
    if (route) {
      const body = await readBody(req)
      const action = route[1]()
      const result = await action.main(toParams(req, url, body, route[0]))
      return send(res, result)
    }

    return serveStatic(res, url.pathname)
  } catch (err) {
    logger.error('unhandled request failure', err?.stack || String(err))
    return send(res, {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'internal error' })
    })
  }
})

if (require.main === module) {
  server.listen(PORT, () => {
    logger.info(`Agent Manager listening on :${PORT}`, `storage=${process.env.STORAGE_DRIVER || 'fs'}`)
  })
}

module.exports = { server, toParams }
