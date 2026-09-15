/**
 * Local-disk driver — the Docker default, and what runs in tests and dev.
 *
 * A container with a mounted volume behaves like the blob store the app
 * expects, which means the whole thing runs with no cloud account at all.
 * That is the point: you can hand someone this repo and a Docker daemon and
 * they see the real product.
 */

const fs = require('fs/promises')
const path = require('path')

const ROOT = () => path.resolve(process.env.STORAGE_ROOT || '/data')

/** Reject traversal outside the root. Paths come from our own code, but a
 *  storage layer that can be walked out of is not one worth having. */
function resolve (key) {
  const full = path.resolve(ROOT(), key)
  if (full !== ROOT() && !full.startsWith(ROOT() + path.sep)) {
    throw new Error(`refusing to access ${key} outside the storage root`)
  }
  return full
}

async function walk (dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

async function init () {
  await fs.mkdir(ROOT(), { recursive: true })

  return {
    async read (key) {
      return fs.readFile(resolve(key))
    },

    async write (key, data) {
      const full = resolve(key)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, Buffer.isBuffer(data) ? data : String(data))
    },

    async delete (key) {
      try {
        await fs.rm(resolve(key), { recursive: true, force: true })
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    },

    // Two meanings, as the contract requires: a trailing slash lists a prefix,
    // anything else is an existence check on one exact key.
    async list (key) {
      const full = resolve(key)
      if (String(key).endsWith('/')) {
        const files = await walk(full)
        return files.map(f => ({
          name: path.relative(ROOT(), f).split(path.sep).join('/')
        }))
      }
      try {
        await fs.stat(full)
        return [{ name: String(key) }]
      } catch (e) {
        if (e.code === 'ENOENT') return []
        throw e
      }
    }
  }
}

module.exports = { init }
