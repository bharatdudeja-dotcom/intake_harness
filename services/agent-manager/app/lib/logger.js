/**
 * Logger — a host-neutral stand-in for @adobe/aio-sdk's Core.Logger.
 *
 * Structured JSON to stdout, which is what every container platform wants:
 * Cloud Run, ECS, Lambda and Kubernetes all collect stdout without config.
 * Keeps Core.Logger's shape (an object with level methods and a `name`) so
 * the action wrappers did not have to change.
 */

const LEVELS = ['error', 'warn', 'info', 'debug']

function Logger (name, options = {}) {
  const level = String(options.level || process.env.LOG_LEVEL || 'info').toLowerCase()
  const threshold = LEVELS.indexOf(LEVELS.includes(level) ? level : 'info')

  const emit = (severity, args) => {
    if (LEVELS.indexOf(severity) > threshold) return
    const message = args
      .map(a => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ')
    process.stdout.write(JSON.stringify({
      severity: severity.toUpperCase(), logger: name, message,
      time: new Date().toISOString()
    }) + '\n')
  }

  const api = { name }
  for (const severity of LEVELS) api[severity] = (...args) => emit(severity, args)
  api.close = () => {}
  return api
}

function safeJson (value) {
  try { return JSON.stringify(value) } catch (e) { return String(value) }
}

module.exports = { Logger, Core: { Logger } }
