/**
 * Turnouts, draw-outs and doctor releases — Form F.
 *
 * The office logs who is not competing and why. The engine decides whether a
 * turnout is fineable and what comes back to the contestant; this surface just
 * records the call and reads it back for the fines list that travels with the
 * results.
 */

import type { FastifyPluginAsync } from 'fastify';

import { classifyTurnoutLog, summarizeTurnoutLog } from '@rodeo-os/engine';
import type { TurnoutLogType, TurnoutSummaryRow } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerTurnoutsModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/turnouts — the log plus a fines-list summary. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/turnouts',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listTurnouts(tx, request.params.org_id, request.params.rodeo_id),
      );
      const summary = summarizeTurnoutLog(
        rows.map(
          (r): TurnoutSummaryRow => ({
            log_type: r.log_type as TurnoutLogType,
            fineable: r.fineable,
            fee_owed_cents: r.fee_owed_cents,
            fine_cents: r.fine_cents,
          }),
        ),
      );
      return reply.send({
        data: rows,
        meta: { request_id: request.id, summary },
      });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/turnouts
   *
   * The engine classifies the row — fineable or not, fee owed, refund due —
   * and the result is stored so the money is settled once and read back the
   * same everywhere.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      log_type: TurnoutLogType;
      rodeo_event_id?: string;
      entry_id?: string;
      contestant_id?: string;
      member_number?: string;
      performance_number?: number;
      notified_how?: string;
      notified_at?: string;
      performance_at?: string;
      required_notice_hours?: number;
      entry_fee_cents?: number;
      fine_amount_cents?: number;
      is_team_roping?: boolean;
      partner_notified?: boolean;
      animal_note?: string;
      notes?: string;
    };
  }>(
    '/rodeos/:rodeo_id/turnouts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['log_type'],
          additionalProperties: false,
          properties: {
            log_type: { type: 'string', enum: ['TO', 'NTO', 'PTO', 'DR', 'VI', 'DO'] },
            rodeo_event_id: { type: 'string', format: 'uuid' },
            entry_id: { type: 'string', format: 'uuid' },
            contestant_id: { type: 'string', format: 'uuid' },
            member_number: { type: 'string', maxLength: 48 },
            performance_number: { type: 'integer', minimum: 0 },
            notified_how: { type: 'string', maxLength: 200 },
            notified_at: { type: 'string', format: 'date-time' },
            performance_at: { type: 'string', format: 'date-time' },
            required_notice_hours: { type: 'number', minimum: 0, maximum: 336 },
            entry_fee_cents: { type: 'integer', minimum: 0, maximum: 100_000_00 },
            fine_amount_cents: { type: 'integer', minimum: 0, maximum: 100_000_00 },
            is_team_roping: { type: 'boolean' },
            partner_notified: { type: 'boolean' },
            animal_note: { type: 'string', maxLength: 500 },
            notes: { type: 'string', maxLength: 1000 },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const b = request.body;
      const decision = classifyTurnoutLog({
        log_type: b.log_type,
        notified_at: b.notified_at ?? null,
        performance_at: b.performance_at ?? null,
        required_notice_hours: b.required_notice_hours,
        entry_fee_cents: b.entry_fee_cents,
        fine_amount_cents: b.fine_amount_cents,
        is_team_roping: b.is_team_roping,
        partner_notified: b.partner_notified,
      });

      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.createTurnout(tx, request.params.org_id, request.params.rodeo_id, {
          rodeo_event_id: b.rodeo_event_id ?? null,
          entry_id: b.entry_id ?? null,
          contestant_id: b.contestant_id ?? null,
          member_number: b.member_number ?? null,
          performance_number: b.performance_number ?? null,
          log_type: b.log_type,
          notified_how: b.notified_how ?? null,
          notified_at: b.notified_at ?? null,
          is_team_roping: b.is_team_roping ?? false,
          partner_notified: b.partner_notified ?? false,
          fee_owed_cents: decision.fee_owed_cents,
          fine_cents: decision.fine_cents,
          fineable: decision.fineable,
          animal_note: b.animal_note ?? null,
          notes: b.notes ?? null,
          created_by: request.auth!.user.user_id,
        }),
      );

      return reply.status(201).send({
        data: { ...row, decision },
        meta: { request_id: request.id },
      });
    },
  );
};
