/**
 * Google Cloud Storage driver — the Cloud Run path.
 *
 * Lazily required, like the S3 driver, so neither cloud's SDK is a dependency
 * of running on the other.
 *
 *   STORAGE_BUCKET   required
 *   STORAGE_PREFIX   optional key prefix
 *
 * Credentials come from Application Default Credentials, so a Cloud Run
 * service account needs no key file and no secret in the environment.
 */

function sdk () {
  try {
    return require('@google-cloud/storage')
  } catch (e) {
    throw new Error(
      'STORAGE_DRIVER=gcs needs the Google Cloud Storage SDK. Install it with:\n' +
      '  npm install @google-cloud/storage'
    )
  }
}

async function init () {
  const { Storage } = sdk()

  const bucketName = process.env.STORAGE_BUCKET
  if (!bucketName) throw new Error('STORAGE_DRIVER=gcs requires STORAGE_BUCKET')
  const prefix = process.env.STORAGE_PREFIX || ''
  const key = k => `${prefix}${k}`
  const unkey = k => (prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k)

  const bucket = new Storage().bucket(bucketName)
  const missing = e => e?.code === 404

  return {
    async read (k) {
      const [buf] = await bucket.file(key(k)).download()
      return buf
    },

    async write (k, data) {
      await bucket.file(key(k)).save(
        Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
        { resumable: false }
      )
    },

    async delete (k) {
      try {
        await bucket.file(key(k)).delete()
      } catch (e) {
        if (!missing(e)) throw e
      }
    },

    async list (k) {
      if (String(k).endsWith('/')) {
        const [files] = await bucket.getFiles({ prefix: key(k) })
        return files.map(f => ({ name: unkey(f.name) }))
      }
      const [exists] = await bucket.file(key(k)).exists()
      return exists ? [{ name: String(k) }] : []
    }
  }
}

module.exports = { init }
