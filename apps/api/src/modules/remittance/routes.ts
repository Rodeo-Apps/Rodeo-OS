/**
 * Close-out cover sheet — Form M money side.
 *
 * The secretary enters each money line once (fees taken in, fines taken in,
 * prize paid, association cut sent, and so on). The engine adds up what should
 * be in the deposit and flags an out-of-balance close before the bag leaves the
 * building.
 */

import type { FastifyPluginAsync } from 'fastify';

import { reconcileRemittance } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

/** The money categories the sheet tracks. `deposit` is the counted bag. */
const CATEGORIES = [
  'fees_collected',
  'fines_collected',
  'stalls_camp_gate',
  'prize_paid',
  'assn_cut_sent',
  'unclaimed_sent',
  'deposit',
] as const;

type Category = (typeof CATEGORIES)[number];

/** Fold the stored category rows into the engine's reconciliation input. */
function toReconcileInput(rows: sec.RemittanceItemRow[]) {
  const byCategory = new Map<string, sec.RemittanceItemRow>();
  for (const row of rows) byCategory.set(row.category, row);
  const cents = (c: Category): number =>
    byCategory.get(c)?.amount_cents ?? 0;
  const depositRow = byCategory.get('deposit');
  return {
    fees_collected_cents: cents('fees_collected'),
    fines_collected_cents: cents('fines_collected'),
    stalls_camp_gate_cents: cents('stalls_camp_gate'),
    prize_paid_cents: cents('prize_paid'),
    assn_cut_sent_cents: cents('assn_cut_sent'),
    unclaimed_sent_cents: cents('unclaimed_sent'),
    deposit_cents: depositRow ? depositRow.amount_cents : null,
  };
}

export const registerRemittanceModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /rodeos/:rodeo_id/remittance — the entered lines plus the live
   * reconciliation of the deposit.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
  }>('/rodeos/:rodeo_id/remittance', async (request, reply) => {
    const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
      sec.listRemittance(tx, request.params.org_id, request.params.rodeo_id),
    );
    const reconciliation = reconcileRemittance(toReconcileInput(rows));
    return reply.send({
      data: { items: rows, reconciliation },
      meta: { request_id: request.id },
    });
  });

  /**
   * PUT /rodeos/:rodeo_id/remittance/:category — set one money line.
   * Re-entering a category updates it in place.
   */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string; category: string };
    Body: {
      amount_cents: number;
      deposit_slip?: string | null;
      note?: string | null;
    };
  }>(
    '/rodeos/:rodeo_id/remittance/:category',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount_cents'],
          additionalProperties: false,
          properties: {
            amount_cents: { type: 'integer', minimum: 0 },
            deposit_slip: { type: ['string', 'null'], maxLength: 100 },
            note: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('books.close'),
    },
    async (request, reply) => {
      const category = request.params.category;
      if (!(CATEGORIES as readonly string[]).includes(category)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_CATEGORY',
            message: `category must be one of: ${CATEGORIES.join(', ')}.`,
          },
          meta: { request_id: request.id },
        });
      }
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertRemittanceItem(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
          {
            category,
            amount_cents: b.amount_cents,
            deposit_slip: b.deposit_slip ?? null,
            note: b.note ?? null,
            created_by: request.auth!.user.user_id,
          },
        ),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );
};
