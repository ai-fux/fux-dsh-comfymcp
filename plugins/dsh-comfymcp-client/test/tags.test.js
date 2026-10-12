import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTagStore } from '../lib/tags.js'

let workdir

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'comfymcp-tags-'))
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true }).catch(() => {})
})

describe('createTagStore', () => {
  it('merges tags/collections and persists across store instances', async () => {
    const store = createTagStore({ dataDir: workdir })
    store.update('C:\\a\\out.png', { tags: ['夕阳', '沙滩'], collections: ['旅拍'] })
    store.update('C:\\a\\out.png', { tags: ['比基尼', '夕阳'] })
    const record = store.get('C:\\a\\out.png')
    expect(record.tags).toEqual(['夕阳', '沙滩', '比基尼'])
    expect(record.collections).toEqual(['旅拍'])
    const raw = JSON.parse(await readFile(join(workdir, 'tags.json'), 'utf8'))
    expect(raw.records['C:\\a\\out.png'].tags).toHaveLength(3)
    const second = createTagStore({ dataDir: workdir })
    expect(second.get('C:\\a\\out.png').tags).toHaveLength(3)
  })

  it('supports tagsSet replacement, dynamic fields with null delete, prompt/source binding', () => {
    const store = createTagStore({ dataDir: workdir })
    store.update('k', { tags: ['a', 'b'], fields: { 尺寸: '1024x1024', 模型: 'sdxl' }, prompt: 'p1', source: '项目A' })
    const updated = store.update('k', { tagsSet: ['c'], fields: { 模型: null, 步数: 20 }, prompt: 'p2' })
    expect(updated.tags).toEqual(['c'])
    expect(updated.fields).toEqual({ 尺寸: '1024x1024', 步数: 20 })
    expect(updated.prompt).toBe('p2')
    expect(updated.source).toBe('项目A')
    expect(createTagStore({ dataDir: workdir }).get('k').fields).toEqual({ 尺寸: '1024x1024', 步数: 20 })
  })

  it('drops empty tag strings and removes records (boundary)', () => {
    const store = createTagStore({ dataDir: workdir })
    store.update('k', { tags: ['  ', 'ok', ''] })
    expect(store.get('k').tags).toEqual(['ok'])
    expect(store.remove('missing')).toBe(false)
    expect(store.remove('k')).toBe(true)
    expect(store.get('k')).toBeNull()
    expect(() => store.update('  ', { tags: ['x'] })).toThrow(/key/)
  })

  it('ignores empty dataDir and corrupted files (boundary)', async () => {
    expect(createTagStore({ dataDir: '' }).all()).toEqual({})
    await writeFile(join(workdir, 'tags.json'), '{broken', 'utf8')
    expect(createTagStore({ dataDir: workdir }).all()).toEqual({})
  })
})
