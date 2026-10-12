export interface ProtocolIssue {
  path: string
  message: string
}

export class ProtocolError extends Error {
  readonly issues: ProtocolIssue[]

  constructor(message: string, issues: ProtocolIssue[] = []) {
    super(message)
    this.name = 'ProtocolError'
    this.issues = issues
  }
}

/**
 * G7: a v1→v2 migration cannot proceed because it needs human input — there is
 * no safe canonical value to synthesise (e.g. a declared connector with no
 * kind). A migrating consumer must supply the missing value and re-run.
 */
export class MigrationConflictError extends ProtocolError {
  /** Where the missing/ambiguous value lives, e.g. `connectors[0].kind`. */
  readonly path: string

  constructor(message: string, path: string) {
    super(message, [{ path, message }])
    this.name = 'MigrationConflictError'
    this.path = path
  }
}
