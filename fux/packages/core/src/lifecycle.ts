import { InvalidTransitionError } from './errors.js'

export type PluginState = 'registered' | 'starting' | 'started' | 'stopping' | 'stopped' | 'broken'

const ALLOWED_TRANSITIONS: Readonly<Record<PluginState, readonly PluginState[]>> = {
  registered: ['starting'],
  starting: ['started', 'broken'],
  started: ['stopping', 'broken'],
  stopping: ['stopped', 'broken'],
  stopped: ['starting'],
  broken: [],
}

export function canTransition(from: PluginState, to: PluginState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export class LifecycleManager {
  private readonly states = new Map<string, PluginState>()

  init(pluginId: string): void {
    this.states.set(pluginId, 'registered')
  }

  get(pluginId: string): PluginState | undefined {
    return this.states.get(pluginId)
  }

  transition(pluginId: string, to: PluginState): PluginState {
    const from = this.states.get(pluginId)
    if (!from) {
      throw new InvalidTransitionError(pluginId, 'untracked', to)
    }
    if (!canTransition(from, to)) {
      throw new InvalidTransitionError(pluginId, from, to)
    }
    this.states.set(pluginId, to)
    return to
  }

  reset(pluginId: string): boolean {
    return this.states.delete(pluginId)
  }

  snapshot(): ReadonlyMap<string, PluginState> {
    return new Map(this.states)
  }
}
