/**
 * Rule infractions and field fines — Form G.
 *
 * A judge calls it, the secretary records it, and once it is posted it is
 * frozen: "a contestant may not talk a posted mark off the sheet." A barrier
 * or field fine cannot post until the barrier judge has verified it. A
 * correction is a NEW row that references the one it corrects — the database
 * trigger from 0030 refuses any edit or delete of a posted row, so this surface
 * never has to be the thing that remembers the rule.
 */

import type { FastifyPluginAsync } from 'fastify';

import { summarizeInfractions, validateInfraction } from '@rodeo-os/engine';
import type { InfractionType } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerInfractionsModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/infractions — the sheet, plus a fines summary. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/infractions',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listInfractions(tx, request.params.org_id, request.params.rodeo_id),
      );
      const summary = summarizeInfractions(
        rows.map((r) => ({
          infraction_type: r.infraction_type,
          fine_cents: r.fine_cents,
          posted_at: r.posted_at,
        })),
      );
      return reply.send({
        data: rows,
        meta: { request_id: request.id, summary },
      });
    },
  );

  /** POST /rodeos/:rodeo_id/infractions — record a draft (never posted here). */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      infraction_type: InfractionType;
      fine_cents?: number;
      rule_code?: string;
      rodeo_event_id?: string;
      contestant_id?: string;
      member_number?: string;
      judge_id?: string;
      verified_by_barrier_judge?: boolean;
      corrects_infraction_id?: string;
      notes?: string;
    };
  }>(
    '/rodeos/:rodeo_id/infractions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['infraction_type'],
          additionalProperties: false,
          properties: {
            infraction_type: {
              type: 'string',
              enum: ['barrier', 'field', 'conduct', 'stock', 'other'],
            },
            fine_cents: { type: 'integer', minimum: 0, maximum: 100_000_00 },
            rule_code: { type: 'string', maxLength: 48 },
            rodeo_event_id: { type: 'string', format: 'uuid' },
            contestant_id: { type: 'string', format: 'uuid' },
            member_number: { type: 'string', maxLength: 48 },
            judge_id: { type: 'string', format: 'uuid' },
            verified_by_barrier_judge: { type: 'boolean' },
            corrects_infraction_id: { type: 'string', format: 'uuid' },
            notes: { type: 'string', maxLength: 1000 },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const b = request.body;
      const validation = validateInfraction({
        infraction_type: b.infraction_type,
        fine_cents: b.fine_cents,
        rule_code: b.rule_code ?? null,
        judge_id: b.judge_id ?? null,
        verified_by_barrier_judge: b.verified_by_barrier_judge,
      });

      if (!validation.valid) {
        return reply.status(422).send({
          error: {
            code: 'INFRACTION_INVALID',
            message: 'This infraction is not well formed.',
            details: validation.issues,
          },
          meta: { request_id: request.id },
        });
      }

      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.createInfraction(tx, request.params.org_id, request.params.rodeo_id, {
          rodeo_event_id: b.rodeo_event_id ?? null,
          contestant_id: b.contestant_id ?? null,
          member_number: b.member_number ?? null,
          infraction_type: b.infraction_type,
          rule_code: b.rule_code ?? null,
          fine_cents: b.fine_cents ?? 0,
          judge_id: b.judge_id ?? null,
          verified_by_barrier_judge: b.verified_by_barrier_judge ?? false,
          corrects_infraction_id: b.corrects_infraction_id ?? null,
          notes: b.notes ?? null,
          created_by: request.auth!.user.user_id,
        }),
      );

      return reply.status(201).send({
        data: { ...row, validation },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST /rodeos/:rodeo_id/infractions/:id/verify — barrier judge sign-off. */
  fastify.post<{ Params: { org_id: string; rodeo_id: string; id: string } }>(
    '/rodeos/:rodeo_id/infractions/:id/verify',
    { preHandler: requirePermission('score.correct') },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.verifyInfraction(tx, request.params.org_id, request.params.id),
      );
      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_A_DRAFT',
            message: 'No draft infraction to verify — it may already be posted.',
          },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/infractions/:id/post
   *
   * Puts it on the office sheet and freezes it. A barrier or field fine that
   * the barrier judge has not verified cannot post — the engine says so and the
   * request is refused before the update runs.
   */
  fastify.post<{ Params: { org_id: string; rodeo_id: string; id: string } }>(
    '/rodeos/:rodeo_id/infractions/:id/post',
    { preHandler: requirePermission('score.correct') },
    async (request, reply) => {
      const { org_id, id } = request.params;
      const out = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const rows = await sec.listInfractions(tx, org_id, request.params.rodeo_id);
        const target = rows.find((r) => r.id === id);
        if (!target) return { code: 'NOT_FOUND' as const };
        if (target.posted_at) return { code: 'ALREADY_POSTED' as const };

        const validation = validateInfraction({
          infraction_type: target.infraction_type as InfractionType,
          fine_cents: target.fine_cents,
          judge_id: target.judge_id,
          verified_by_barrier_judge: target.verified_by_barrier_judge,
        });
        if (!validation.can_post) return { code: 'CANNOT_POST' as const, validation };

        const row = await sec.postInfraction(tx, org_id, id);
        return { code: 'OK' as const, row };
      });

      if (out.code === 'NOT_FOUND') {
        return reply.status(404).send({
          error: { code: 'INFRACTION_NOT_FOUND', message: 'No such infraction.' },
          meta: { request_id: request.id },
        });
      }
      if (out.code === 'ALREADY_POSTED') {
        return reply.status(409).send({
          error: {
            code: 'ALREADY_POSTED',
            message: 'This infraction is already posted and is immutable.',
          },
          meta: { request_id: request.id },
        });
      }
      if (out.code === 'CANNOT_POST') {
        return reply.status(422).send({
          error: {
            code: 'CANNOT_POST',
            message: 'This infraction cannot be posted yet.',
            details: out.validation.issues,
          },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: out.row, meta: { request_id: request.id } });
    },
  );
};
