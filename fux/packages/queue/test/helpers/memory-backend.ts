import type { TaskJournalDoc, TaskJournalLike } from '../../src/index.js'

/**
 * Test double mirroring the `VersionedBackend<T>` shape (append-only versions
 * under one key) with optional async plumbing, so the structural compatibility
 * between `VersionedBackend` and `TaskJournalLike` is exercised without adding
 * a package dependency on `@fux/storage`.
 */
interface Version<T> {
  readonly key: string
  readonly version: string
  readonly value: T
  readonly createdAt: number
}

export interface MemoryBackendLikeOptions {
  /** Serve every journal operation through a promise (async backend path). */
  readonly async?: boolean
  /** Make every `put` throw (journal-write failure on the submit path). */
  readonly failPut?: boolean
  /** Make every `delete` throw (event-driven maintenance failure). */
  readonly failDelete?: boolean
}

export class MemoryBackendLike implements TaskJournalLike {
  private readonly buckets = new Map<string, Array<Version<TaskJournalDoc>>>()
  private readonly counters = new Map<string, number>()
  private readonly options: MemoryBackendLikeOptions

  constructor(options: MemoryBackendLikeOptions = {}) {
    this.options = options
  }

  /** Synchronous visibility check (test convenience). */
  syncHas(key: string): boolean {
    const bucket = this.buckets.get(key)
    return !!bucket && bucket.length > 0
  }

  head(key: string): Version<TaskJournalDoc> | undefined {
    const bucket = this.buckets.get(key)
    return bucket && bucket.length > 0 ? bucket[bucket.length - 1] : undefined
  }

  /** Pre-seed a journal document (recovery tests). */
  seed(key: string, doc: TaskJournalDoc): void {
    const n = this.counters.get(key) ?? 0
    this.counters.set(key, n + 1)
    this.buckets.set(key, [
      { key, version: String(n), value: doc, createdAt: Date.now() },
    ])
  }

  put(key: string, value: TaskJournalDoc): Version<TaskJournalDoc> | Promise<Version<TaskJournalDoc>> {
    const write = (): Version<TaskJournalDoc> => {
      if (this.options.failPut) throw new Error('journal put failed')
      const n = this.counters.get(key) ?? 0
      this.counters.set(key, n + 1)
      const entry: Version<TaskJournalDoc> = { key, version: String(n), value, createdAt: Date.now() }
      const bucket = this.buckets.get(key) ?? []
      bucket.push(entry)
      this.buckets.set(key, bucket)
      return entry
    }
    return this.options.async ? Promise.resolve().then(write) : write()
  }

  get(key: string): Version<TaskJournalDoc> | undefined | Promise<Version<TaskJournalDoc> | undefined> {
    const read = (): Version<TaskJournalDoc> | undefined => this.head(key)
    return this.options.async ? Promise.resolve().then(read) : read()
  }

  delete(key: string): boolean | Promise<boolean> {
    const del = (): boolean => {
      if (this.options.failDelete) throw new Error('journal delete failed')
      this.counters.delete(key)
      return this.buckets.delete(key)
    }
    return this.options.async ? Promise.resolve().then(del) : del()
  }
}
