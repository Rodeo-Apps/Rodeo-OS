/**
 * Performance mode — the live office/arena state for each performance.
 *
 * One row per (rodeo, performance_number). The office screen and the arena
 * screen read the same row so they never disagree about which event and which
 * position is up. Moving a performance forward updates the same row rather than
 * writing a new one.
 */

import type { FastifyPluginAsync } from 'fastify';

import { isUuid, requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

const STATES = [
  'not_started',
  'in_progress',
  'section_complete',
  'reconciled',
  'closed',
] as const;

export const registerPerformanceModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/performance-state — every performance's live state. */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
  }>('/rodeos/:rodeo_id/performance-state', async (request, reply) => {
    const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
      sec.listPerformanceStates(
        tx,
        request.params.org_id,
        request.params.rodeo_id,
      ),
    );
    return reply.send({ data: rows, meta: { request_id: request.id } });
  });

  /**
   * PUT /rodeos/:rodeo_id/performance-state/:performance_number
   *
   * Set the live state of one performance. Re-sending updates the same row;
   * started_at is stamped the first time it goes in_progress and ended_at when
   * it closes.
   */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string; performance_number: string };
    Body: {
      state: (typeof STATES)[number];
      current_event_id?: string | null;
      current_run_position?: number | null;
    };
  }>(
    '/rodeos/:rodeo_id/performance-state/:performance_number',
    {
      schema: {
        body: {
          type: 'object',
          required: ['state'],
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: STATES as unknown as string[] },
            current_event_id: { type: ['string', 'null'], format: 'uuid' },
            current_run_position: { type: ['integer', 'null'], minimum: 0 },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const performanceNumber = Number(request.params.performance_number);
      if (!Number.isInteger(performanceNumber) || performanceNumber < 0) {
        return reply.status(400).send({
          error: {
            code: 'BAD_PERFORMANCE',
            message: 'performance_number must be a non-negative integer.',
          },
          meta: { request_id: request.id },
        });
      }
      const b = request.body;
      if (b.current_event_id && !isUuid(b.current_event_id)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'current_event_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertPerformanceState(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
          performanceNumber,
          {
            state: b.state,
            current_event_id: b.current_event_id ?? null,
            current_run_position: b.current_run_position ?? null,
            updated_by: request.auth!.user.user_id,
          },
        ),
      );
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );
};
