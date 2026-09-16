/**
 * Form K — Arena measurement / judges' check.
 *
 * The one sheet the judges and secretary fill in on the morning before the
 * first competition animal runs: box lengths, score line, barrier height, the
 * barrel pattern, cattle counts and any humane note. It exists so that "the
 * scoreline was short" is a thing that was measured and posted, not a thing
 * argued about after a run.
 *
 * One sheet per rodeo, so the surface is get-one / put-one.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerArenaCheckModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/arena-measurements — the current sheet, or null. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/arena-measurements',
    { preHandler: requirePermission('score.correct') },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.getArenaMeasurement(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** PUT /rodeos/:rodeo_id/arena-measurements — create or update the sheet. */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string };
    Body: sec.ArenaMeasurementInput & { posted?: boolean };
  }>(
    '/rodeos/:rodeo_id/arena-measurements',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            box_length_l: { type: ['string', 'null'], maxLength: 40 },
            box_length_r: { type: ['string', 'null'], maxLength: 40 },
            scoreline_length: { type: ['string', 'null'], maxLength: 40 },
            barrier_height: { type: ['string', 'null'], maxLength: 40 },
            electric_eye: { type: 'boolean' },
            even_cattle_marked: { type: 'boolean' },
            cloverleaf_measured: { type: 'boolean' },
            pattern: { type: ['string', 'null'], maxLength: 200 },
            flagger_position: { type: ['string', 'null'], maxLength: 120 },
            backup_watches: { type: 'boolean' },
            num_bareback: { type: ['integer', 'null'], minimum: 0 },
            num_saddle_bronc: { type: ['integer', 'null'], minimum: 0 },
            num_bull: { type: ['integer', 'null'], minimum: 0 },
            timed_cattle_count: { type: ['integer', 'null'], minimum: 0 },
            fresh_used_note: { type: ['string', 'null'], maxLength: 300 },
            humane_issues: { type: ['string', 'null'], maxLength: 500 },
            posted_with_draw: { type: 'boolean' },
            notes: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertArenaMeasurement(tx, request.params.org_id, request.params.rodeo_id, {
          ...b,
          measured_at: b.posted_with_draw ? new Date().toISOString() : undefined,
          created_by: request.auth!.user.user_id,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );
};
