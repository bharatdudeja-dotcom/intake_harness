/**
 * Deploy the built actions straight to I/O Runtime.
 *
 * WHY THIS EXISTS RATHER THAN `aio app deploy`
 *
 * The CLI does not upload to Runtime. It uploads to an App Builder "deploy
 * service" which then forwards - and that host,
 * deploy-service.app-builder.adp.adobe.io, resolves to an ELB in ap-northeast-1
 * that this network cannot open a TCP connection to. Every deploy therefore
 * died after a 30 second hang with `socket hang up`, including a 60-byte test
 * action, which is what ruled out payload size.
 *
 * Runtime's own API answers in half a second from the same machine, with the
 * same credentials. So this PUTs the zips the CLI already built - `aio app
 * build` works fine, it is only the upload leg that is blocked.
 *
 * WHAT IT DELIBERATELY REPRODUCES FROM THE MANIFEST
 *
 * Inputs (with $VARS resolved from .env), limits, and annotations. An action
 * deployed without its annotations is not the same action: `web-export` decides
 * whether it is reachable at all, and `raw-http` decides whether it sees the
 * real request body. Getting those wrong would produce a deployment that exists
 * and does not work, which is worse than one that failed.
 */

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const APP = process.argv[2] || '.'
const ENV_PATH = path.join(APP, '.env')
const MANIFEST = path.join(APP, 'app.config.yaml')

/** Read .env into a map, without disturbing the process environment. */
function readEnv () {
  const out = {}
  if (!fs.existsSync(ENV_PATH)) return out
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnv()
const AUTH = env.AIO_runtime_auth || env.AIO_RUNTIME_AUTH
const NS = env.AIO_runtime_namespace || env.AIO_RUNTIME_NAMESPACE
// The host that is actually reachable. Not the deploy service.
const HOST = 'https://adobeioruntime.net'

if (!AUTH || !NS) {
  console.error('No runtime credentials in .env - run `aio app use` first.')
  process.exit(1)
}

/**
 * Resolve `$VAR` inputs against .env.
 *
 * An unset variable becomes an EMPTY STRING, not the literal "$VAR". Sending
 * the literal would deploy an action whose OIDC issuer is the five characters
 * "$OIDC" - configuration that looks present and is nonsense. Empty is the
 * honest representation of "not configured", and the code already treats it
 * that way.
 */
function resolveInputs (inputs) {
  const out = {}
  for (const [key, raw] of Object.entries(inputs || {})) {
    if (typeof raw === 'string' && raw.startsWith('$')) {
      out[key] = env[raw.slice(1)] ?? ''
    } else {
      out[key] = raw
    }
  }
  return out
}

function annotationsFor (name, cfg) {
  const a = cfg.annotations || {}
  const list = []
  // `web: 'yes'` in the manifest IS the web-export annotation.
  const webExport = a['web-export'] ?? (cfg.web === 'yes' || cfg.web === true)
  list.push({ key: 'web-export', value: !!webExport })
  list.push({ key: 'raw-http', value: !!a['raw-http'] })
  list.push({ key: 'final', value: !!a.final })
  if (a['web-custom-options']) list.push({ key: 'web-custom-options', value: true })
  if (a['require-adobe-auth'] !== undefined) {
    list.push({ key: 'require-adobe-auth', value: !!a['require-adobe-auth'] })
  }
  list.push({ key: 'exec', value: cfg.runtime || 'nodejs:20' })
  return list
}

async function put (name, cfg) {
  const zipPath = path.join(APP, 'dist', 'application', 'actions', PKG, `${name}.zip`)
  if (!fs.existsSync(zipPath)) throw new Error(`no built zip at ${zipPath} - run \`aio app build\``)

  const body = {
    namespace: NS,
    name,
    exec: {
      kind: cfg.runtime || 'nodejs:20',
      code: fs.readFileSync(zipPath).toString('base64'),
      binary: true,
      main: 'main'
    },
    limits: {
      timeout: (cfg.limits && cfg.limits.timeout) || 60000,
      memory: (cfg.limits && cfg.limits.memory) || 256
    },
    parameters: Object.entries(resolveInputs(cfg.inputs)).map(([key, value]) => ({ key, value })),
    annotations: annotationsFor(name, cfg)
  }

  const url = `${HOST}/api/v1/namespaces/${encodeURIComponent(NS)}/actions/${encodeURIComponent(PKG)}/${encodeURIComponent(name)}?overwrite=true`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(AUTH).toString('base64')
    },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/** The package has to exist before actions can be put inside it. */
async function ensurePackage () {
  const url = `${HOST}/api/v1/namespaces/${encodeURIComponent(NS)}/packages/${encodeURIComponent(PKG)}?overwrite=true`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(AUTH).toString('base64')
    },
    body: JSON.stringify({ namespace: NS, name: PKG, publish: false })
  })
  if (!res.ok) throw new Error(`package: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

const doc = yaml.load(fs.readFileSync(MANIFEST, 'utf8'))
const packages = doc.application.runtimeManifest.packages
const PKG = Object.keys(packages)[0]
const actions = packages[PKG].actions

;(async () => {
  console.log(`namespace ${NS}  package ${PKG}`)
  await ensurePackage()
  console.log('package ready')

  let ok = 0
  for (const [name, cfg] of Object.entries(actions)) {
    // Triggers and rules are not actions and are not deployed here.
    if (!cfg.function) { console.log(`  skip     ${name} (not an action)`); continue }
    try {
      await put(name, cfg)
      const web = cfg.web === 'yes' ? 'web' : 'non-web'
      console.log(`  deployed ${name.padEnd(22)} ${web}`)
      ok++
    } catch (e) {
      console.log(`  FAILED   ${name.padEnd(22)} ${e.message}`)
    }
  }
  console.log(`\n${ok}/${Object.values(actions).filter(c => c.function).length} actions deployed`)
  console.log(`base URL: https://${NS}.adobeioruntime.net/api/v1/web/${PKG}/`)
})().catch((e) => { console.error(e.message); process.exit(1) })
