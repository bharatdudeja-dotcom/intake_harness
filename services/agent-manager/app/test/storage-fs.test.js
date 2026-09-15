/**
 * The local-disk storage driver.
 *
 * This is the driver the Docker image runs by default, so it is the one that
 * decides whether "clone it and `docker compose up`" actually works. The other
 * drivers (s3, gcs) are thin wrappers over SDKs and are exercised against real
 * buckets, not mocked here — mocking an SDK only tests the mock.
 *
 * The contract under test is aio-lib-files': read/write/delete, plus `list`
 * carrying two meanings — an existence check on an exact key, and a prefix
 * listing when the key ends in "/".
 */

const os = require('os')
const path = require('path')
const fsp = require('fs/promises')

const driver = require('../lib/storage/fs')

let root
let files

beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'am-storage-'))
    process.env.STORAGE_ROOT = root
    files = await driver.init()
})

afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
    delete process.env.STORAGE_ROOT
})

describe('the local-disk storage driver', () => {
    test('round-trips a value, and read returns a Buffer as callers expect', async () => {
        await files.write('resources/index.json', JSON.stringify([{ id: 'a' }]))
        const buf = await files.read('resources/index.json')
        expect(Buffer.isBuffer(buf)).toBe(true)
        expect(JSON.parse(buf.toString('utf8'))).toEqual([{ id: 'a' }])
    })

    test('write creates parent directories rather than failing on a deep key', async () => {
        await files.write('a/b/c/d/deep.json', '{}')
        expect((await files.list('a/b/c/d/deep.json'))).toHaveLength(1)
    })

    test('write accepts a Buffer as well as a string, for binary assets', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
        await files.write('assets/x.png', png)
        expect(await files.read('assets/x.png')).toEqual(png)
    })

    // store.js uses list-on-an-exact-path as its existence check, so an absent
    // key must be an empty array and never a throw.
    test('list on an exact key is an existence check', async () => {
        expect(await files.list('resources/settings.json')).toEqual([])
        await files.write('resources/settings.json', '{}')
        expect(await files.list('resources/settings.json')).toEqual([
            { name: 'resources/settings.json' }
        ])
    })

    test('list on a trailing slash returns every key beneath the prefix', async () => {
        await files.write('resources/one.json', '1')
        await files.write('resources/two.json', '2')
        await files.write('resources/nested/three.json', '3')
        await files.write('other/four.json', '4')

        const names = (await files.list('resources/')).map(e => e.name).sort()
        expect(names).toEqual([
            'resources/nested/three.json',
            'resources/one.json',
            'resources/two.json'
        ])
    })

    test('list uses forward slashes regardless of host platform', async () => {
        await files.write('resources/nested/deep.json', '{}')
        const [entry] = await files.list('resources/')
        expect(entry.name).toBe('resources/nested/deep.json')
        expect(entry.name).not.toContain('\\')
    })

    test('list on an absent prefix is empty, not an error', async () => {
        await expect(files.list('nothing-here/')).resolves.toEqual([])
    })

    test('delete removes a key and is idempotent on one that is already gone', async () => {
        await files.write('resources/gone.json', '{}')
        await files.delete('resources/gone.json')
        expect(await files.list('resources/gone.json')).toEqual([])
        await expect(files.delete('resources/gone.json')).resolves.toBeUndefined()
    })

    test('reading an absent key rejects, so a caller cannot mistake it for empty', async () => {
        await expect(files.read('resources/missing.json')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    // The keys are ours, not user input — but a storage layer that can be walked
    // out of is not one worth having.
    test('refuses to escape the storage root', async () => {
        await expect(files.write('../escaped.json', 'x')).rejects.toThrow(/outside the storage root/)
        await expect(files.read('../../etc/passwd')).rejects.toThrow(/outside the storage root/)
    })
})

describe('driver selection', () => {
    afterEach(() => { delete process.env.STORAGE_DRIVER })

    test('rejects an unknown driver by name instead of falling back silently', () => {
        jest.resetModules()
        process.env.STORAGE_DRIVER = 'dropbox'
        const { driverName } = require('../lib/storage')
        expect(() => driverName()).toThrow(/unknown STORAGE_DRIVER "dropbox"/)
    })

    test('defaults to local disk, which is what the container runs', () => {
        jest.resetModules()
        delete process.env.STORAGE_DRIVER
        const { driverName } = require('../lib/storage')
        expect(driverName()).toBe('fs')
    })
})
