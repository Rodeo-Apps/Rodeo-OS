/**
 * Payout module routes.
 *
 * Architecture ref: §4.1 "RESULTS & PAYOUTS", §6.
 *
 * Calculation and disbursement are separate endpoints on purpose. A producer
 * looks at the numbers before money leaves the account, and the calculation is
 * idempotent so they can re-run it as many times as they like without side
 * effects.
 */

import type { FastifyPluginAsync } from 'fastify';

import { formatCents } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as repo from '../../core/database/repositories.ts';
import {
  calculateEventPayout,
  crossCheckBlockers,
  payEnvelope,
} from '../../core/desk-actions.ts';
import { SettlementError, settleBatch } from '../../core/settlement.ts';

export const registerPayoutsModule: FastifyPluginAsync = async (fastify) => {
  /**
   * POST .../events/:event_id/calculate-payouts
   *
   * Returns the full breakdown without writing a ledger row. Safe to call
   * repeatedly.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { payout_config_id?: string; dry_run?: boolean };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/calculate-payouts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            payout_config_id: { type: 'string', format: 'uuid' },
            dry_run: { type: 'boolean', default: true },
          },
        },
      },
      preHandler: requirePermission('payout.calculate'),
    },
    async (request, reply) => {
      const { org_id, event_id } = request.params;

      const claims = claimsFor(request.auth!);
      const ctx = await fastify.db.asUser(claims, (tx) =>
        repo.loadPayoutContext(tx, org_id, event_id, request.body.payout_config_id),
      );

      if (!ctx) {
        return reply.status(404).send({
          error: {
            code: 'PAYOUT_CONTEXT_NOT_FOUND',
            message:
              'No such event, or it has no payout config. Set one on the event ' +
              'or pass payout_config_id.',
          },
          meta: { request_id: request.id },
        });
      }

      const calc = calculateEventPayout(ctx);

      if (calc.kind === 'failed') {
        return reply.status(422).send({
          error: {
            code: 'PAYOUT_CALCULATION_FAILED',
            message: 'The payout could not be calculated.',
            details: { issues: calc.issues },
          },
          meta: { request_id: request.id },
        });
      }

      // A reconciliation failure here is a bug, not a user error. Refuse to
      // return numbers that do not add up rather than let a producer disburse
      // them. §7.4 tracks this with a target of zero.
      if (calc.kind !== 'ok') {
        request.log.error({ org_id, event_id, calc }, 'payout does not reconcile');
        return reply.status(500).send({
          error: {
            code: 'PAYOUT_DOES_NOT_RECONCILE',
            message: 'Internal payout reconciliation failed; nothing was written.',
          },
          meta: { request_id: request.id },
        });
      }
      const result = calc.result;

      fastify.eventBus.emit('payout.calculated', {
        org_id,
        rodeo_event_id: event_id,
        net_purse_cents: result.net_purse_cents,
        lines: result.payouts.length,
      });

      return reply.send({
        data: {
          ...result,
          display: {
            gross_purse: formatCents(result.gross_purse_cents),
            fees: formatCents(result.fees.total_cents),
            net_purse: formatCents(result.net_purse_cents),
            payouts: result.payouts.map((p) => ({
              ...p,
              amount: formatCents(p.amount_cents),
            })),
          },
        },
        meta: { request_id: request.id, timestamp: new Date().toISOString() },
      });
    },
  );

  /**
   * POST .../payouts/disburse
   *
   * Writes ledger rows and moves money via Stripe Connect. Restricted to
   * owner/admin, and idempotent on the supplied key so a retried request after
   * a network timeout cannot pay twice.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: { idempotency_key: string; confirm: boolean; rodeo_event_id: string };
  }>(
    '/rodeos/:rodeo_id/payouts/disburse',
    {
      schema: {
        body: {
          type: 'object',
          required: ['idempotency_key', 'confirm', 'rodeo_event_id'],
          additionalProperties: false,
          properties: {
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
            confirm: { type: 'boolean', const: true },
            rodeo_event_id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: requirePermission('payout.disburse'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;

      // Recalculated here rather than trusting numbers posted by the client.
      // The caller says WHICH event to pay, never HOW MUCH — otherwise the
      // whole cent-exact engine is decoration.
      const claims = claimsFor(request.auth!);
      const ctx = await fastify.db.asUser(claims, (tx) =>
        repo.loadPayoutContext(tx, org_id, request.body.rodeo_event_id),
      );

      if (!ctx) {
        return reply.status(404).send({
          error: { code: 'PAYOUT_CONTEXT_NOT_FOUND', message: 'No such event.' },
          meta: { request_id: request.id },
        });
      }

      const calc = calculateEventPayout(ctx);
      if (calc.kind === 'failed') {
        return reply.status(422).send({
          error: {
            code: 'PAYOUT_CALCULATION_FAILED',
            message: 'The payout could not be calculated; nothing was disbursed.',
            details: { issues: calc.issues },
          },
          meta: { request_id: request.id },
        });
      }
      if (calc.kind !== 'ok') {
        request.log.error({ org_id, rodeo_id }, 'payout does not reconcile');
        return reply.status(500).send({
          error: {
            code: 'PAYOUT_DOES_NOT_RECONCILE',
            message: 'Internal reconciliation failed; nothing was written.',
          },
          meta: { request_id: request.id },
        });
      }
      const calculated = calc.result;

      // Nobody is paid off one record: every run's judge card has to agree
      // with its timer sheet first.
      const blockers = await fastify.db.asUser(claims, (tx) =>
        crossCheckBlockers(tx, org_id, request.body.rodeo_event_id),
      );
      if (blockers && blockers.length > 0) {
        return reply.status(409).send({
          error: {
            code: 'CARDS_DISAGREE',
            message: `${blockers.length} run(s) where the judge card and the timer sheet do not agree.`,
            details: { blockers },
          },
          meta: { request_id: request.id },
        });
      }

      // Ledger write and idempotency check share one transaction, so a
      // concurrent duplicate request blocks on the unique index rather than
      // racing past it.
      const out = await fastify.db.asUser(claims, (tx) =>
        repo.disburse(
          tx,
          org_id,
          rodeo_id,
          request.body.idempotency_key,
          request.auth!.user.user_id,
          calculated.payouts.map((p) => ({
            contestant_id: p.contestant_id,
            amount_cents: p.amount_cents,
            type: p.type,
            place: p.place,
            go_round: p.go_round,
            d_division: p.d_division,
          })),
        ),
      );

      if (!out.already_disbursed) {
        fastify.eventBus.emit('payout.disbursed', {
          org_id,
          transaction_id: out.idempotency_key,
        });
      }

      return reply.send({
        data: { ...out, display_total: formatCents(out.total_cents) },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * POST .../payouts/settle
   *
   * The money physically left. At a jackpot that is the secretary emptying the
   * cash box; at a big rodeo it is checks or a Stripe transfer. Same endpoint
   * either way — settlement is a state machine over the ledger, not a Stripe
   * wrapper, so a producer with no card processor is not a second-class user.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      idempotency_key: string;
      payment_method: string;
      reference?: string;
      confirm: boolean;
    };
  }>(
    '/rodeos/:rodeo_id/payouts/settle',
    {
      schema: {
        body: {
          type: 'object',
          required: ['idempotency_key', 'payment_method', 'confirm'],
          additionalProperties: false,
          properties: {
            idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
            payment_method: { type: 'string', maxLength: 32 },
            reference: { type: 'string', maxLength: 200 },
            confirm: { type: 'boolean', const: true },
          },
        },
      },
      preHandler: requirePermission('payout.disburse'),
    },
    async (request, reply) => {
      const { org_id } = request.params;
      try {
        const out = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          settleBatch(tx, {
            org_id,
            idempotency_key: request.body.idempotency_key,
            to_status: 'completed',
            payment_method: request.body.payment_method,
            reference: request.body.reference,
            actor_id: request.auth!.user.user_id,
          }),
        );

        return reply.send({
          data: { ...out, display_total: formatCents(out.total_cents) },
          meta: { request_id: request.id },
        });
      } catch (err) {
        if (err instanceof SettlementError) {
          return reply.status(err.code === 'BATCH_NOT_FOUND' ? 404 : 409).send({
            error: { code: err.code, message: err.message },
            meta: { request_id: request.id },
          });
        }
        throw err;
      }
    },
  );

  /**
   * POST .../events/:event_id/pay-cash
   *
   * The winner envelopes. Calculates on the server, writes the ledger and
   * settles it as cash in one step — at a jackpot the money leaves the cash
   * box the moment the event is official, and there is no processor to wait
   * for. The same payEnvelope() call is what POST /sync uses for envelopes she
   * filled with no signal.
   *
   * Refused (409) until every run's judge card agrees with its timer sheet
   * and the event is official. If she sends what she counted, a total that is
   * not the server's is refused rather than paid.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: {
      confirm: boolean;
      envelope_total_cents?: number;
      lines?: { contestant_id: string; amount_cents: number }[];
      reference?: string;
    };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/pay-cash',
    {
      schema: {
        body: {
          type: 'object',
          required: ['confirm'],
          additionalProperties: false,
          properties: {
            confirm: { type: 'boolean', const: true },
            envelope_total_cents: { type: 'integer', minimum: 0 },
            lines: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['contestant_id', 'amount_cents'],
                additionalProperties: false,
                properties: {
                  contestant_id: { type: 'string', format: 'uuid' },
                  amount_cents: { type: 'integer', minimum: 0 },
                },
              },
            },
            reference: { type: 'string', maxLength: 200 },
          },
        },
      },
      preHandler: requirePermission('payout.disburse'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const body = request.body;

      const out = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        payEnvelope(tx, {
          org_id,
          rodeo_id,
          rodeo_event_id: event_id,
          actor_id: request.auth!.user.user_id,
          confirm: body.confirm,
          payment_method: 'cash',
          reference: body.reference,
          claim:
            body.envelope_total_cents === undefined
              ? undefined
              : { envelope_total_cents: body.envelope_total_cents, lines: body.lines },
        }),
      );

      const fail = (status: number, code: string, message: string, details?: unknown) =>
        reply.status(status).send({
          error: { code, message, ...(details ? { details } : {}) },
          meta: { request_id: request.id },
        });

      switch (out.kind) {
        case 'not_found':
          return fail(404, 'PAYOUT_CONTEXT_NOT_FOUND', 'No such event, or it has no payout config.');
        case 'unconfirmed':
          return fail(400, 'CONFIRM_REQUIRED', 'Confirm before paying the envelopes.');
        case 'blocked':
          return fail(409, 'CARDS_DISAGREE', out.message, { blockers: out.blockers });
        case 'not_official':
          return fail(409, 'NOT_OFFICIAL', out.message);
        case 'mismatch':
          return fail(409, 'ENVELOPE_MISMATCH', out.message, {
            server_total_cents: out.server_total_cents,
            envelope_total_cents: out.envelope_total_cents,
            server_lines: out.server_lines,
          });
        case 'failed':
          return fail(422, 'PAYOUT_CALCULATION_FAILED', 'The payout could not be calculated.', {
            issues: out.issues,
          });
        case 'unreconciled':
          return fail(500, 'PAYOUT_DOES_NOT_RECONCILE', 'Internal reconciliation failed; nothing was paid.');
      }

      if (!out.already_paid && out.total_cents > 0) {
        fastify.eventBus.emit('payout.disbursed', {
          org_id,
          transaction_id: `disburse-${event_id}`,
        });
      }

      return reply.send({
        data: { ...out, display_total: formatCents(out.total_cents) },
        meta: { request_id: request.id },
      });
    },
  );
};

// Storage lives in core/database/repositories.ts.
