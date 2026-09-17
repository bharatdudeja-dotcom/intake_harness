/**
 * Storage drivers — the one piece of real infrastructure coupling in this app.
 *
 * `lib/store.js` was always written against a four-method blob interface and
 * documents itself as a SWAP POINT. This module is that swap, made explicit:
 * the same four methods, over whichever backend the environment names.
 *
 *   STORAGE_DRIVER=fs       local disk           (the Docker default)
 *   STORAGE_DRIVER=s3       S3, MinIO, R2        (AWS, or anything S3-compatible)
 *   STORAGE_DRIVER=gcs      Google Cloud Storage (Cloud Run)
 *   STORAGE_DRIVER=aio      Adobe I/O Files      (the original host)
 *   STORAGE_DRIVER=postgres Any reachable Postgres (one row per blob)
 *
 * The contract every driver implements, matching @adobe/aio-lib-files exactly
 * so `lib/store.js` did not have to change its call sites:
 *
 *   read(path)            -> Buffer                 (throws if absent)
 *   write(path, data)     -> void                   (creates parents)
 *   delete(path)          -> void                   (tolerates absent)
 *   list(path)            -> Array<{name}>
 *
 * `list` carries two meanings, both of which callers rely on:
 *   - an exact path      -> [] when absent, one entry when present
 *                           (store.js uses this as an existence check)
 *   - a path ending "/"  -> every object beneath that prefix
 *
 * Drivers for S3, GCS, and Postgres require their SDK lazily, so none is a
 * dependency of running this app on one of the others.
 */

const DRIVERS = ['fs', 's3', 'gcs', 'aio', 'postgres']

/**
 * Required eagerly, and deliberately so. A lazy `require` here binds to
 * whichever module registry exists at CALL time, which differs from the one at
 * load time as soon as anything calls jest.resetModules() - and the suites that
 * do exactly that then hand the driver a different mock than the one they set
 * up. Requiring up front costs nothing: each driver module only defines
 * functions, and the S3 and GCS SDKs are still required lazily inside init().
 */
const DRIVER_MODULES = {
  fs: require('./fs'),
  s3: require('./s3'),
  gcs: require('./gcs'),
  aio: require('./aio'),
  postgres: require('./postgres')
}

let cached = null

/** @returns {string} the configured driver id, defaulting to local disk. */
function driverName () {
  const name = String(process.env.STORAGE_DRIVER || 'fs').toLowerCase()
  if (!DRIVERS.includes(name)) {
    throw new Error(
      `unknown STORAGE_DRIVER "${name}". Expected one of: ${DRIVERS.join(', ')}`
    )
  }
  return name
}

/**
 * Resolve the configured storage driver. Cached, because every driver is a
 * stateless wrapper over a client that is itself safe to reuse.
 * @returns {Promise<{read: Function, write: Function, delete: Function, list: Function}>}
 */
async function getStorage () {
  if (cached) return cached
  cached = await DRIVER_MODULES[driverName()].init()
  return cached
}

/** Test seam: drop the cached client so the next call re-reads the environment. */
function resetStorage () {
  cached = null
}

module.exports = { getStorage, resetStorage, driverName, DRIVERS }
