/**
 * Position trades — Form E.
 *
 * A contestant swaps their spot in the draw for another. The engine holds the
 * rules — trades have to be allowed, cannot be into the same section, are due
 * before the stock draw (riding) or the first-head last time (timed), and are
 * capped at two per go-round. This surface counts what the contestant already
 * has, asks the engine, and only writes the trade if it is clean.
 */

import type { FastifyPluginAsync } from 'fastify';

import { validateTrade } from '@rodeo-os/engine';
import type { TradeDiscipline } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerTradesModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/trades — every trade recorded for the rodeo. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/trades',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listTrades(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/trades
   *
   * Validated by the engine before anything is written. A trade that breaks a
   * rule comes back 422 with the reasons, not a half-recorded swap.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      rodeo_event_id: string;
      discipline: TradeDiscipline;
      go_round_number: number;
      contestant_a_id: string;
      contestant_b_id?: string;
      is_open?: boolean;
      from_performance_number?: number | null;
      from_position?: number | null;
      from_is_slack?: boolean;
      to_performance_number?: number | null;
      to_position?: number | null;
      to_is_slack?: boolean;
      trades_allowed: boolean;
      deadline_at?: string;
      now?: string;
      max_trades_per_go?: number;
      notes?: string;
    };
  }>(
    '/rodeos/:rodeo_id/trades',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rodeo_event_id', 'discipline', 'go_round_number', 'contestant_a_id', 'trades_allowed'],
          additionalProperties: false,
          properties: {
            rodeo_event_id: { type: 'string', format: 'uuid' },
            discipline: { type: 'string', enum: ['riding', 'timed'] },
            go_round_number: { type: 'integer', minimum: 1 },
            contestant_a_id: { type: 'string', format: 'uuid' },
            contestant_b_id: { type: 'string', format: 'uuid' },
            is_open: { type: 'boolean' },
            from_performance_number: { type: ['integer', 'null'], minimum: 0 },
            from_position: { type: ['integer', 'null'], minimum: 0 },
            from_is_slack: { type: 'boolean' },
            to_performance_number: { type: ['integer', 'null'], minimum: 0 },
            to_position: { type: ['integer', 'null'], minimum: 0 },
            to_is_slack: { type: 'boolean' },
            trades_allowed: { type: 'boolean' },
            deadline_at: { type: 'string', format: 'date-time' },
            now: { type: 'string', format: 'date-time' },
            max_trades_per_go: { type: 'integer', minimum: 1, maximum: 10 },
            notes: { type: 'string', maxLength: 1000 },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const b = request.body;
      const { org_id, rodeo_id } = request.params;

      const result = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const existing = await sec.countTradesThisGo(
          tx,
          org_id,
          b.rodeo_event_id,
          b.go_round_number,
          b.contestant_a_id,
        );

        const validation = validateTrade({
          discipline: b.discipline,
          go_round_number: b.go_round_number,
          from: {
            performance_number: b.from_performance_number ?? null,
            is_slack: b.from_is_slack,
            position: b.from_position ?? null,
          },
          to: {
            performance_number: b.to_performance_number ?? null,
            is_slack: b.to_is_slack,
            position: b.to_position ?? null,
          },
          trades_allowed: b.trades_allowed,
          deadline_at: b.deadline_at ?? null,
          now: b.now ?? null,
          existing_trades_this_go: existing,
          max_trades_per_go: b.max_trades_per_go,
          is_open: b.is_open,
        });

        if (!validation.ok) return { validation, row: null };

        const row = await sec.createTrade(tx, org_id, rodeo_id, {
          rodeo_event_id: b.rodeo_event_id,
          event_discipline: b.discipline,
          go_round_number: b.go_round_number,
          contestant_a_id: b.contestant_a_id,
          contestant_b_id: b.contestant_b_id ?? null,
          is_open: b.is_open ?? false,
          from_performance_number: b.from_performance_number ?? null,
          from_position: b.from_position ?? null,
          to_performance_number: b.to_performance_number ?? null,
          to_position: b.to_position ?? null,
          trade_number: validation.trade_number,
          notes: b.notes ?? null,
          created_by: request.auth!.user.user_id,
        });
        return { validation, row };
      });

      if (!result.row) {
        return reply.status(422).send({
          error: {
            code: 'TRADE_REJECTED',
            message: 'This trade breaks a rule and was not recorded.',
            details: result.validation.issues,
          },
          meta: { request_id: request.id },
        });
      }

      return reply.status(201).send({
        data: { ...result.row, validation: result.validation },
        meta: { request_id: request.id },
      });
    },
  );
};
