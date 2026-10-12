import { z } from 'zod'
import { ConnectorKindSchema } from './product.js'
import { EVENT_SCHEMA_VERSION } from './event-schema.js'
import { MigrationConflictError } from './errors.js'
import type { IpcEvent } from './index.js'
import type { PluginManifest } from './manifest.js'

/**
 * G7: the explicit, opt-in migration path to protocol `0.2.0`.
 *
 * The live protocol stays `0.1.1` (`FUX_PROTOCOL_VERSION`) — nothing about how
 * the runtime parses data changes. This module pins the *target* contract and
 * per-kind v1→v2 transformers, so a consumer that actually cuts over to a
 * product requiring `0.2.0` has a mechanical, validated route instead of a
 * redesign. See ADR-0035.
 */

/** The target protocol version of the strict contract below. */
export const PROTOCOL_VERSION_V2 = '0.2.0'

// ---------------------------------------------------------------------------
// v2 target types — the canonical, strict shapes.
// ---------------------------------------------------------------------------

/**
 * v2 permission: `scope` is required. Absent maps to `'*'` (unscoped) so the
 * canonical shape always carries an explicit scope.
 */
export const PermissionV2Schema = z.object({
  resource: z.string().min(1).max(128),
  action: z.string().min(1).max(32),
  scope: z.string().min(1).max(128).default('*'),
})
export type PermissionV2 = z.infer<typeof PermissionV2Schema>

/**
 * v2 IPC event: `schemaVersion` is required. Absent maps to the current unified
 * event-schema version (v1 events stay readable — they are stamped, not lost).
 */
export const IpcEventV2Schema = z.object({
  topic: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,31}:[a-z][a-z0-9-]{1,31}$/)
    .max(100),
  payload: z.unknown().optional(),
  source: z.string().min(1).max(200).optional(),
  occurredAt: z.number().int().nonnegative(),
  schemaVersion: z.number().int().positive().max(9999).default(EVENT_SCHEMA_VERSION),
})
export type IpcEventV2 = z.infer<typeof IpcEventV2Schema>

/** A v1 connector definition, structurally — kind is advisory/optional. */
export interface ConnectorDefinitionV1Like {
  readonly id: string
  readonly kind?: 'request_reply' | 'publish_subscribe' | 'stream'
  readonly config?: Record<string, unknown>
}

/** v2 connector definition: `kind` required with no default. */
export const ConnectorDefinitionV2Schema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/),
  kind: ConnectorKindSchema,
  config: z.record(z.string(), z.unknown()).default({}),
})
export type ConnectorDefinitionV2 = ConnectorDefinitionV1Like & {
  readonly kind: NonNullable<ConnectorDefinitionV1Like['kind']>
}

/** v2 product: `connectors[].kind` required. */
export interface ProductDefinitionV2 {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly profile?: 'dev' | 'team'
  readonly plugins: readonly {
    readonly id: string
    readonly enabled?: boolean
    readonly config?: Record<string, unknown>
  }[]
  readonly connectors: readonly ConnectorDefinitionV2[]
}

/**
 * v2 manifest: `permissions[].scope` required. Manifest retains its full shape;
 * only the permission sub-shape canonicalizes.
 */
export interface PluginManifestV2 extends Omit<PluginManifest, 'permissions'> {
  readonly permissions?: PermissionV2[]
}

// ---------------------------------------------------------------------------
// v1 → v2 transformers
// ---------------------------------------------------------------------------

const scopeFallback = '*'

interface PermissionLike {
  readonly resource: string
  readonly action: string
  readonly scope?: string
}

/**
 * Transform a v1 permission into its v2 canonical form. A missing `scope`
 * becomes `'*'` (unscoped).
 */
export function migratePermissionV1toV2(permission: PermissionLike): PermissionV2 {
  return {
    resource: permission.resource,
    action: permission.action,
    scope: permission.scope ?? scopeFallback,
  }
}

/**
 * Transform a v1 manifest into its v2 canonical form. Missing permission scopes
 * are filled with `'*'`; all other fields pass through byte-for-byte.
 */
export function migrateManifestV1toV2(manifest: PluginManifest): PluginManifestV2 {
  return {
    ...manifest,
    permissions: manifest.permissions?.map(migratePermissionV1toV2),
  }
}

/**
 * Transform a v1 IPC event into its v2 canonical form. A missing
 * `schemaVersion` is stamped with the current unified event-schema version.
 */
export function migrateEventV1toV2(event: IpcEvent): IpcEventV2 {
  return { ...event, schemaVersion: event.schemaVersion ?? EVENT_SCHEMA_VERSION }
}

/**
 * Transform a single v1 connector definition, failing loudly when `kind` is
 * absent. `index` is only used to report a precise path for the error.
 */
export function migrateConnectorV1toV2(
  connector: ConnectorDefinitionV1Like,
  index = 0,
): ConnectorDefinitionV2 {
  if (!connector.kind) {
    throw new MigrationConflictError(
      `connector at connectors[${index}] has no kind; supply one (request_reply | publish_subscribe | stream) to migrate to ${PROTOCOL_VERSION_V2}`,
      `connectors[${index}].kind`,
    )
  }
  return { ...connector, kind: connector.kind }
}

/**
 * Transform a v1 product definition into its v2 canonical form.
 *
 * `connectors[].kind` is a **required** field in v2 with no safe default. A
 * declared connector that lacks a kind throws `MigrationConflictError` — the
 * caller must supply the kind and re-run. This is the deliberate
 * "requires human input" case: guessing a pathway kind would be wrong.
 */
export function migrateProductV1toV2(product: {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly profile?: 'dev' | 'team'
  readonly plugins: readonly {
    readonly id: string
    readonly enabled?: boolean
    readonly config?: Record<string, unknown>
  }[]
  readonly connectors?: readonly ConnectorDefinitionV1Like[]
}): ProductDefinitionV2 {
  return {
    ...product,
    connectors: (product.connectors ?? []).map((connector, index) =>
      migrateConnectorV1toV2(connector, index),
    ),
  }
}
