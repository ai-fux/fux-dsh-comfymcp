import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadArtifacts, kindFromFilename, resolveArtifactUrl, safeArtifactFilename } from '../src/artifacts.js'

let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'mcp-comfy-artifacts-'))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('artifact helpers', () => {
  it('resolves relative urls against the endpoint and keeps absolute ones', () => {
    expect(resolveArtifactUrl('http://127.0.0.1:18800/mcp', '/artifacts/x')).toBe('http://127.0.0.1:18800/artifacts/x')
    expect(resolveArtifactUrl('http://127.0.0.1:18800/mcp', 'http://other/x')).toBe('http://other/x')
  })

  it('sanitizes filenames and rejects traversal', () => {
    expect(safeArtifactFilename({ url: 'u', filename: '..\\..\\evil.png' }, 0)).toBe('evil.png')
    expect(safeArtifactFilename({ url: 'u', filename: '' }, 2)).toBe('artifact-3')
    expect(safeArtifactFilename({ url: 'u', filename: '..' }, 0)).toBe('artifact-1')
  })

  it('derives kinds from extensions', () => {
    expect(kindFromFilename('a.png')).toBe('image')
    expect(kindFromFilename('b.MP4')).toBe('video')
    expect(kindFromFilename('c.mp3')).toBe('audio')
    expect(kindFromFilename('d.bin')).toBe('file')
  })
})

describe('downloadArtifacts', () => {
  let server: ReturnType<typeof createServer> | undefined
  let baseUrl = ''

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/artifacts/ok.png') {
        res.setHeader('content-type', 'image/png')
        res.setHeader('content-length', '4')
        res.end(Buffer.from([1, 2, 3, 4]))
        return
      }
      res.statusCode = 404
      res.end('gone')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  })

  afterEach(async () => {
    server?.close()
    await once(server!, 'close').catch(() => {})
  })

  it('downloads refs into the dir and reports the manifest (happy path)', async () => {
    const files = await downloadArtifacts({
      endpoint: `${baseUrl}/mcp`,
      artifactsDir: join(workdir, 'out'),
      refs: [{ url: '/artifacts/ok.png', filename: 'hello.png', kind: 'image', bytes: 4 }],
    })
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ filename: 'hello.png', kind: 'image', bytes: 4 })
    const content = await readFile(files[0]!.path)
    expect(content).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('fails with E_ARTIFACT_HTTP on a 404 ref (error path)', async () => {
    await expect(
      downloadArtifacts({
        endpoint: `${baseUrl}/mcp`,
        artifactsDir: join(workdir, 'out'),
        refs: [{ url: '/artifacts/missing.png', filename: 'missing.png' }],
      }),
    ).rejects.toMatchObject({ code: 'E_ARTIFACT_HTTP' })
  })

  it('requires a configured dir and short-circuits empty refs (boundary)', async () => {
    await expect(
      downloadArtifacts({ endpoint: `${baseUrl}/mcp`, artifactsDir: '', refs: [{ url: '/x' }] }),
    ).rejects.toMatchObject({ code: 'E_ARTIFACT_DIR' })
    await expect(
      downloadArtifacts({ endpoint: `${baseUrl}/mcp`, artifactsDir: join(workdir, 'out'), refs: [] }),
    ).resolves.toEqual([])
  })

  it('uniquifies colliding filenames', async () => {
    const files = await downloadArtifacts({
      endpoint: `${baseUrl}/mcp`,
      artifactsDir: join(workdir, 'out2'),
      refs: [
        { url: '/artifacts/ok.png', filename: 'same.png' },
        { url: '/artifacts/ok.png', filename: 'same.png' },
      ],
    })
    expect(files).toHaveLength(2)
    expect(files[0]!.path).not.toBe(files[1]!.path)
  })
})
