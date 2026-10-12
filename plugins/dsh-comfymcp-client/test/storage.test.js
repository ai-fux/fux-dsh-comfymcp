import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalStorage, createMinioStorage, createOssStorage, normalizeKey, resolveStorage, signOssRequest, signS3Request, s3SigningKey } from '../lib/storage.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-storage-'))
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

describe('normalizeKey', () => {
  it('normalizes separators and rejects traversal (boundary)', () => {
    expect(normalizeKey('a\\b\\c.png')).toBe('a/b/c.png')
    expect(normalizeKey('/x//y/./z')).toBe('x/y/z')
    expect(() => normalizeKey('../etc/passwd')).toThrow(/\.\./)
    expect(() => normalizeKey('')).toThrow()
  })
})

describe('createLocalStorage', () => {
  it('roundtrips put/get/list/remove and builds artifact urls', async () => {
    const storage = createLocalStorage({ rootDir: workdir })
    await storage.put('run-1/out.png', Buffer.from([1, 2, 3]))
    await storage.put('run-1/meta.json', '{"ok":true}')
    const listed = await storage.list()
    expect(listed.map((entry) => entry.key).sort()).toEqual(['run-1/meta.json', 'run-1/out.png'])
    const png = listed.find((entry) => entry.key === 'run-1/out.png')
    expect(png.kind).toBe('image')
    const got = await storage.get('run-1/out.png')
    expect(got.bytes).toEqual(Buffer.from([1, 2, 3]))
    expect(got.contentType).toBe('image/png')
    expect(storage.url('run-1/out.png')).toContain('path=')
    await storage.remove('run-1/out.png')
    await expect(storage.get('run-1/out.png')).rejects.toThrow(/gone/)
  })

  it('contains reads inside the root (boundary)', async () => {
    const outside = join(workdir, '..', 'outside.txt')
    await writeFile(outside, 'secret')
    const storage = createLocalStorage({ rootDir: join(workdir, 'root') })
    await expect(storage.get('../outside.txt')).rejects.toThrow(/\.\./)
  })
})

describe('S3 / OSS signing', () => {
  it('derives the signing key exactly per the AWS documented chain', async () => {
    // 独立表达式（AWS 文档公式）交叉验证 helper 接线：
    // DateKey=HMAC("AWS4"+Secret, Date); ×Region; ×Service; ×"aws4_request"
    const { createHmac } = await import('node:crypto')
    const h = (key, data) => createHmac('sha256', key).update(data).digest()
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    const expected = h(h(h(h(`AWS4${secret}`, '20120215'), 'us-east-1'), 'iam'), 'aws4_request')
    expect(Buffer.from(s3SigningKey(secret, '20120215', 'us-east-1', 'iam')).toString('hex'))
      .toBe(Buffer.from(expected).toString('hex'))
  })

  it('signs S3 requests deterministically with a fixed clock', () => {
    const a = signS3Request({
      method: 'GET',
      url: 'http://127.0.0.1:9000/bucket/run-1/out.png',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      now: '20261011T000000Z',
    })
    const b = signS3Request({
      method: 'GET',
      url: 'http://127.0.0.1:9000/bucket/run-1/out.png',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      now: '20261011T000000Z',
    })
    expect(a.authorization).toBe(b.authorization)
    expect(a.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261011\/us-east-1\/s3\/aws4_request/)
    expect(a['x-amz-date']).toBe('20261011T000000Z')
  })

  it('signs OSS requests with the OSS4 scheme', () => {
    const signed = signOssRequest({
      method: 'PUT',
      url: 'https://bucket.oss-cn-chengdu.aliyuncs.com/artifacts/a.png',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      region: 'cn-chengdu',
      now: '20261011T000000Z',
    })
    expect(signed.authorization).toContain('OSS4-HMAC-SHA256')
    expect(signed.authorization).toContain('/cn-chengdu/oss/aliyun_v4_request')
    expect(signed['x-oss-date']).toBe('20261011T000000Z')
  })
})

describe('resolveStorage', () => {
  it('selects local/minio/oss by config and requires their fields (boundary)', () => {
    expect(resolveStorage({ storage: 'local', artifactsDir: workdir }).id).toBe('local')
    expect(resolveStorage({}).id).toBe('local')
    expect(() => resolveStorage({ storage: 'minio' })).toThrow(/endpoint/)
    expect(() => resolveStorage({ storage: 'oss' })).toThrow(/endpoint/)
    const minio = resolveStorage({ storage: 'minio', storageEndpoint: 'http://127.0.0.1:9000', storageBucket: 'b', storageAccessKey: 'a', storageSecret: 's' })
    expect(minio.id).toBe('minio')
    expect(minio.url('x/y.png')).toContain('/b/x/y.png')
    const oss = resolveStorage({ storage: 'oss', storageEndpoint: 'https://oss.example.com', storageBucket: 'b', storageAccessKey: 'a', storageSecret: 's', storagePrefix: 'pfx' })
    expect(oss.id).toBe('oss')
    expect(oss.url('x.png')).toContain('/pfx/x.png')
  })
})

describe('minio/oss providers (no live server)', () => {
  it('list/get fail with a descriptive transport error (boundary)', async () => {
    const minio = createMinioStorage({ endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })
    await expect(minio.list()).rejects.toThrow(/storage request failed|fetch failed/)
    const oss = createOssStorage({ endpoint: 'http://127.0.0.1:9', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })
    await expect(oss.list()).rejects.toThrow(/storage request failed|fetch failed/)
  })
})
