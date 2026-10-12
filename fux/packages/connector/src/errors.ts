/** Base class for connector-framework failures. */
export class ConnectorError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConnectorError'
    this.code = code
  }
}

/** A connector id that is already registered is not allowed. */
export class DuplicateConnectorError extends ConnectorError {
  constructor(connectorId: string) {
    super('E_DUPLICATE_CONNECTOR', `connector "${connectorId}" is already registered`)
    this.name = 'DuplicateConnectorError'
  }
}

/** Referenced a connector id that is not (or no longer) registered. */
export class ConnectorNotFoundError extends ConnectorError {
  constructor(connectorId: string) {
    super('E_CONNECTOR_NOT_FOUND', `connector "${connectorId}" is not registered`)
    this.name = 'ConnectorNotFoundError'
  }
}

/** A lifecycle operation was attempted in a state that does not allow it. */
export class ConnectorStateError extends ConnectorError {
  readonly expected: string
  readonly actual: string

  constructor(connectorId: string, expected: string, actual: string) {
    super(
      'E_CONNECTOR_STATE',
      `connector "${connectorId}" expected state ${expected}, was ${actual}`,
    )
    this.name = 'ConnectorStateError'
    this.expected = expected
    this.actual = actual
  }
}
