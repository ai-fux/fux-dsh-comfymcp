import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { distributeArtifacts } from '../lib/runcore.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-runcore-'))
  await mkdir(join(workdir, 'artifacts'), { recursive: true })
  await writeFile(join(workdir, 'artifacts', 'out.png'), 'PNGDATA', 'utf8')
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

function fakeBridge(config) {
  return {
    config,
    readArtifactBytes: (params) => {
      const path = params.get('path')
      if (path === 'missing') return { error: 'gone' }
      return { bytes: Buffer.from(`bytes-of-${path}`), contentType: 'image/png' }
    },
  }
}

function filesFor() {
  return [
    { path: join(workdir, 'artifacts', 'out.png'), filename: 'out.png', kind: 'image' },
    { path: 'missing', filename: 'missing.png', kind: 'image' },
  ]
}

describe('distributeArtifacts', () => {
  it('mirrors files into the configured downloadDir (relative to homeDir)', async () => {
    const bridge = fakeBridge({ storage: 'local', homeDir: workdir, downloadDir: 'downloads' })
    const result = await distributeArtifacts(bridge, filesFor())
    expect(result.download.dir).toBe(join(workdir, 'downloads'))
    expect(result.download.mirrored).toBe(1)
    const entries = await readdir(join(workdir, 'downloads'))
    expect(entries).toEqual(['out.png'])
  })

  it('reports storage push errors as annotations without throwing (boundary)', async () => {
    const bridge = fakeBridge({ storage: 'minio', homeDir: workdir, downloadDir: '' })
    const result = await distributeArtifacts(bridge, filesFor())
    expect(result.storage.error).toContain('endpoint') // 失败只附注，不影响运行
  })

  it('returns null when nothing to distribute', async () => {
    expect(await distributeArtifacts(fakeBridge({ storage: 'local' }), [])).toBeNull()
    expect(await distributeArtifacts(fakeBridge({ storage: 'local', downloadDir: 'dl' }), null)).toBeNull()
  })
})
