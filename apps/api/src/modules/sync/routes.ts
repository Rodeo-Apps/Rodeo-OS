/**
 * Offline sync endpoint.
 *
 * Architecture ref: §4.4.
 *
 * The secretary's laptop drains its queue here when the link comes back:
 * scores, turnouts, trades, Make official, and the cash she put in the
 * envelopes, in the order she did them. Each change is decided on its own —
 * one that is refused does not take the rest of her night with it.
 */

import type { FastifyPluginAsync } from 'fastify';

import { hasPermission, requirePermission, type Permission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as repo from '../../core/database/repositories.ts';
import {
  resolveConflict,
  toConflict,
  type ServerState,
  type SyncConflict,
  type SyncEntityType,
  type SyncRequest,
  type SyncResponse,
} from '../../core/sync.ts';

/** Each change needs the permission its live route needs. */
const CHANGE_PERMISSION: Record<SyncEntityType, Permission> = {
  score: 'score.submit',
  entry: 'entry.manage',
  result: 'score.submit',
  turnout: 'entry.manage',
  trade: 'entry.manage',
  finalize: 'score.correct',
  cash: 'payout.disburse',
};

/** Thrown inside a change's savepoint so its writes roll back with it. */
class RefusedChange extends Error {
  readonly conflict: SyncConflict;
  constructor(conflict: SyncConflict) {
    super(conflict.explanation);
    this.conflict = conflict;
  }
}

export const registerSyncModule: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { org_id: string }; Body: SyncRequest }>(
    '/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['client_id', 'last_sync_at', 'changes'],
          additionalProperties: false,
          properties: {
            client_id: { type: 'string', minLength: 8, maxLength: 128 },
            last_sync_at: { type: 'string', format: 'date-time' },
            changes: {
              type: 'array',
              // A device that has been offline all weekend still has to be
              // able to drain its queue, but not in one unbounded request.
              maxItems: 500,
              items: {
                type: 'object',
                required: ['id', 'entity_type', 'action', 'data', 'timestamp', 'source'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  entity_type: {
                    type: 'string',
                    enum: ['score', 'entry', 'result', 'turnout', 'trade', 'finalize', 'cash'],
                  },
                  action: { type: 'string', enum: ['create', 'update', 'delete'] },
                  data: { type: 'object' },
                  timestamp: { type: 'string', format: 'date-time' },
                  source: { type: 'string', enum: ['secretary', 'judge', 'timer'] },
                  base_version: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const { org_id } = request.params;
      const { changes, last_sync_at } = request.body;
      const auth = request.auth!;

      const accepted: string[] = [];
      const rejected: SyncConflict[] = [];

      // Ordered by the client's own clock so that a device's own edits apply
      // in the order they were made. Ordering ACROSS devices is decided by
      // authority, not by timestamp. The sort is stable, so two changes with
      // the same timestamp keep the order she sent them in.
      const ordered = [...changes].sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      );

      // One transaction for the batch; one savepoint per change inside it. A
      // change that fails — an engine refusal, a constraint, a desk rule —
      // rolls back to its savepoint and is rejected alone; everything before
      // and after it still applies.
      const claims = claimsFor(auth);
      const server_changes = await fastify.db.asUser(claims, async (tx) => {
        for (const change of ordered) {
          const permission = CHANGE_PERMISSION[change.entity_type];
          if (!hasPermission(auth, permission)) {
            rejected.push({
              client_change_id: change.id,
              reason: 'validation_error',
              server_version: {},
              resolution: 'server_wins',
              explanation: `Role '${auth.org.role}' may not perform '${permission}'.`,
            });
            continue;
          }

          try {
            const conflict = await tx.savepoint(async (sp) => {
              const serverState = await repo.loadServerState(sp, org_id, change);
              const resolution = resolveConflict(change, serverState);

              if (resolution.winner !== 'client') {
                return toConflict(change, resolution, serverState ?? ({} as ServerState));
              }
              if (resolution.reason === 'already_applied') return null;

              const outcome = await repo.applyChange(
                sp,
                org_id,
                change,
                auth.user.user_id,
                serverState,
              );
              if (outcome.applied) return null;

              throw new RefusedChange({
                client_change_id: change.id,
                reason: outcome.reason,
                server_version: outcome.server_version ?? serverState ?? {},
                resolution: outcome.resolution,
                explanation: outcome.explanation,
              });
            });

            if (conflict) rejected.push(conflict);
            else accepted.push(change.id);
          } catch (err) {
            if (err instanceof RefusedChange) {
              rejected.push(err.conflict);
              continue;
            }
            request.log.warn({ err, change_id: change.id }, 'sync change failed');
            rejected.push({
              client_change_id: change.id,
              reason: 'validation_error',
              server_version: {},
              resolution: 'server_wins',
              explanation: `The server could not apply this change: ${(err as Error).message}`,
            });
          }
        }
        return repo.changesSince(tx, org_id, last_sync_at);
      });

      const response: SyncResponse = {
        accepted,
        rejected,
        server_changes,
        sync_timestamp: new Date().toISOString(),
      };

      return reply.send({
        data: response,
        meta: { request_id: request.id },
      });
    },
  );
};

// Storage lives in core/database/repositories.ts.
