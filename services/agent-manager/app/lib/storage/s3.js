/**
 * S3 driver — AWS, MinIO, Cloudflare R2, anything speaking the S3 API.
 *
 * The SDK is required lazily so that running on Google Cloud, or on local
 * disk, does not drag an AWS dependency into the image.
 *
 *   STORAGE_BUCKET      required
 *   STORAGE_PREFIX      optional key prefix, e.g. "agent-manager/"
 *   AWS_REGION          required by the SDK
 *   S3_ENDPOINT         set for MinIO/R2; omit for real S3
 *   S3_FORCE_PATH_STYLE set to "true" for MinIO
 *
 * Credentials come from the default AWS provider chain, so a task role on ECS
 * or Lambda needs no secret in the environment at all.
 */

function sdk () {
  try {
    return require('@aws-sdk/client-s3')
  } catch (e) {
    throw new Error(
      'STORAGE_DRIVER=s3 needs the AWS SDK. Install it with:\n' +
      '  npm install @aws-sdk/client-s3'
    )
  }
}

async function streamToBuffer (body) {
  if (!body) return Buffer.alloc(0)
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function init () {
  const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = sdk()

  const Bucket = process.env.STORAGE_BUCKET
  if (!Bucket) throw new Error('STORAGE_DRIVER=s3 requires STORAGE_BUCKET')
  const prefix = process.env.STORAGE_PREFIX || ''
  const key = k => `${prefix}${k}`
  const unkey = k => (prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k)

  const client = new S3Client({
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.S3_FORCE_PATH_STYLE === 'true' ? { forcePathStyle: true } : {})
  })

  const missing = e => ['NoSuchKey', 'NotFound'].includes(e?.name) || e?.$metadata?.httpStatusCode === 404

  return {
    async read (k) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key(k) }))
      return streamToBuffer(out.Body)
    },

    async write (k, data) {
      await client.send(new PutObjectCommand({
        Bucket, Key: key(k), Body: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      }))
    },

    async delete (k) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key(k) }))
      } catch (e) {
        if (!missing(e)) throw e
      }
    },

    async list (k) {
      if (String(k).endsWith('/')) {
        const names = []
        let token
        do {
          const page = await client.send(new ListObjectsV2Command({
            Bucket, Prefix: key(k), ContinuationToken: token
          }))
          for (const o of page.Contents || []) names.push({ name: unkey(o.Key) })
          token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token)
        return names
      }
      const page = await client.send(new ListObjectsV2Command({
        Bucket, Prefix: key(k), MaxKeys: 1
      }))
      const hit = (page.Contents || []).find(o => o.Key === key(k))
      return hit ? [{ name: String(k) }] : []
    }
  }
}

module.exports = { init }
