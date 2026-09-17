/**
 * Postgres driver — stores each blob as one row, so any reachable Postgres
 * (including an RDS instance another app already owns) can back this app's
 * storage without a bucket or a mounted volume.
 *
 * The `pg` driver is required lazily so that running on fs/s3/gcs/aio does
 * not drag a Postgres dependency into the image (same reasoning as s3.js
 * and gcs.js — see this directory's index.js header).
 *
 *   DATABASE_URL   required — a standard postgres:// connection string
 *   STORAGE_TABLE  optional — defaults to "agent_manager_objects". Set this
 *                  if DATABASE_URL points at a database another app already
 *                  uses, so the two don't collide on table names.
 */

function sdk () {
  try {
    return require('pg')
  } catch (e) {
    throw new Error(
      'STORAGE_DRIVER=postgres needs the pg package. Install it with:\n' +
      '  npm install pg'
    )
  }
}

// LIKE treats % and _ as wildcards — escape both so a prefix like
// "resources/index.json" can't accidentally match unrelated keys.
function escapeLike (s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

async function init () {
  const { Pool } = sdk()

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('STORAGE_DRIVER=postgres requires DATABASE_URL')
  const table = process.env.STORAGE_TABLE || 'agent_manager_objects'

  const pool = new Pool({ connectionString })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      key TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  return {
    async read (key) {
      const { rows } = await pool.query(`SELECT data FROM ${table} WHERE key = $1`, [key])
      if (rows.length === 0) throw new Error(`no such object: ${key}`)
      return rows[0].data
    },

    async write (key, data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      await pool.query(
        `INSERT INTO ${table} (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [key, buf]
      )
    },

    async delete (key) {
      await pool.query(`DELETE FROM ${table} WHERE key = $1`, [key])
    },

    // Two meanings, as the contract requires: a trailing slash lists a
    // prefix, anything else is an existence check on one exact key.
    async list (key) {
      if (String(key).endsWith('/')) {
        const { rows } = await pool.query(
          `SELECT key FROM ${table} WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
          [`${escapeLike(key)}%`]
        )
        return rows.map((r) => ({ name: r.key }))
      }
      const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE key = $1`, [key])
      return rows.length ? [{ name: String(key) }] : []
    }
  }
}

module.exports = { init }
