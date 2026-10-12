import { describe, expect, it } from 'vitest'
import { LifecycleManager, canTransition } from '../src/lifecycle.js'
import { InvalidTransitionError } from '../src/errors.js'

describe('LifecycleManager', () => {
  it('walks the happy path registered -> started -> stopped', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    expect(manager.get('p1')).toBe('registered')
    manager.transition('p1', 'starting')
    manager.transition('p1', 'started')
    manager.transition('p1', 'stopping')
    manager.transition('p1', 'stopped')
    expect(manager.get('p1')).toBe('stopped')
  })

  it('allows restart from stopped', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    manager.transition('p1', 'starting')
    manager.transition('p1', 'started')
    manager.transition('p1', 'stopping')
    manager.transition('p1', 'stopped')
    manager.transition('p1', 'starting')
    expect(manager.get('p1')).toBe('starting')
  })

  it('rejects illegal transitions', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    expect(() => manager.transition('p1', 'started')).toThrow(InvalidTransitionError)
  })

  it('marks broken from starting and started but never recovers', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    manager.transition('p1', 'starting')
    manager.transition('p1', 'broken')
    expect(() => manager.transition('p1', 'starting')).toThrow(InvalidTransitionError)
  })

  it('rejects transitions for untracked plugins', () => {
    const manager = new LifecycleManager()
    expect(() => manager.transition('ghost', 'starting')).toThrow(InvalidTransitionError)
  })

  it('resets tracking on unregister', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    expect(manager.reset('p1')).toBe(true)
    expect(manager.reset('p1')).toBe(false)
    expect(manager.get('p1')).toBeUndefined()
  })

  it('snapshots current states', () => {
    const manager = new LifecycleManager()
    manager.init('p1')
    manager.init('p2')
    manager.transition('p2', 'starting')
    const snapshot = manager.snapshot()
    expect(snapshot.get('p1')).toBe('registered')
    expect(snapshot.get('p2')).toBe('starting')
  })
})

describe('canTransition', () => {
  it('exposes the transition table', () => {
    expect(canTransition('registered', 'starting')).toBe(true)
    expect(canTransition('registered', 'started')).toBe(false)
    expect(canTransition('broken', 'starting')).toBe(false)
  })
})
