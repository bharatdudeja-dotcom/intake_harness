/**
 * Adobe I/O Runtime hands configuration to an action as PARAMETERS. This code
 * reads it from process.env. This file is the bridge, and without it the
 * manifest's `inputs` block has no effect at all.
 *
 * HOW THIS WAS FOUND
 *
 * The first deployment answered every request with:
 *
 *   STORAGE_ROOT resolved to "/data" (from the default), which cannot be
 *   created: EACCES: permission denied, mkdir '/data'
 *
 * `STORAGE_DRIVER: $STORAGE_DRIVER` was set in app.config.yaml and `aio` had
 * deployed it correctly - as an action parameter, arriving in `main(params)`.
 * Nothing ever copied it into the environment, so lib/storage read
 * `process.env.STORAGE_DRIVER`, found nothing, and fell back to the local-disk
 * driver inside a read-only serverless container.
 *
 * The same was true of every other input: OIDC_ISSUER, SERVICE_API_KEY,
 * BOOTSTRAP_ADMINS. On this host they were all silently empty. Locally they
 * come from real environment variables, which is exactly why it never showed
 * up in development - the container and the laptop agreed, and only the
 * serverless host disagreed.
 *
 * WHY EXISTING VALUES WIN
 *
 * A value already in the environment is not overwritten. On any host that sets
 * real environment variables - Docker, ECS, a laptop - that is the operator's
 * explicit choice, and a stale manifest default silently replacing it would be
 * the same class of bug in the opposite direction.
 */

/** Keys that are Runtime's own plumbing, not application configuration. */
const RUNTIME_KEYS = /^(__ow_|AIO_|_)/

/**
 * Copy string parameters into process.env.
 *
 * Only strings and numbers. A parameter carrying an object or an array is
 * structured data for the action to read from `params` directly, and
 * stringifying it into the environment would produce "[object Object]" - a
 * value that is present, wrong, and hard to trace back to here.
 *
 * @param {object} params the action's parameters, as passed to main
 * @returns {string[]} the names applied, for a log line at startup
 */
function applyParams (params) {
  const applied = []
  if (!params || typeof params !== 'object') return applied

  for (const [key, value] of Object.entries(params)) {
    if (RUNTIME_KEYS.test(key)) continue
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue

    const str = String(value)
    // An input left unresolved by the deployer is worse than absent: "$OIDC_ISSUER"
    // is a five-character issuer that will fail validation somewhere far from here.
    if (str.startsWith('$')) continue
    // Empty means "not configured", and the code already reads absent that way.
    if (str === '') continue
    if (process.env[key] !== undefined && process.env[key] !== '') continue

    process.env[key] = str
    applied.push(key)
  }
  return applied
}

module.exports = { applyParams }
