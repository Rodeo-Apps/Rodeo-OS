/**
 * Form H — Check-in / fee receipt.
 *
 * The arrival desk. A contestant is confirmed as entered, whatever fee is owed
 * is taken, and a receipt goes back. Every dollar recorded here is a dollar the
 * close-out (Form M) will expect to see in the deposit, so the desk writes the
 * moment money crosses it — not later from memory.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerCheckInModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/check-ins — the desk log, newest first. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/check-ins',
    { preHandler: requirePermission('entry.manage') },
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listCheckIns(tx, request.params.org_id, request.params.rodeo_id),
      );
      const collected = rows.reduce((sum, r) => sum + (r.fees_paid_cents ?? 0), 0);
      const due = rows.reduce((sum, r) => sum + (r.fees_due_cents ?? 0), 0);
      return reply.send({
        data: { items: rows, total_collected_cents: collected, total_due_cents: due },
        meta: { request_id: request.id },
      });
    },
  );

  /** POST /rodeos/:rodeo_id/check-ins — record one check-in / receipt. */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      contestant_name: string;
      entry_id?: string | null;
      contestant_id?: string | null;
      member_number?: string | null;
      fees_due_cents?: number;
      fees_paid_cents?: number;
      payment_method?: string;
      receipt_number?: string | null;
      check_number?: string | null;
      notes?: string | null;
    };
  }>(
    '/rodeos/:rodeo_id/check-ins',
    {
      schema: {
        body: {
          type: 'object',
          required: ['contestant_name'],
          additionalProperties: false,
          properties: {
            contestant_name: { type: 'string', minLength: 1, maxLength: 160 },
            entry_id: { type: ['string', 'null'], format: 'uuid' },
            contestant_id: { type: ['string', 'null'], format: 'uuid' },
            member_number: { type: ['string', 'null'], maxLength: 60 },
            fees_due_cents: { type: 'integer', minimum: 0 },
            fees_paid_cents: { type: 'integer', minimum: 0 },
            payment_method: {
              type: 'string',
              enum: ['cash', 'check', 'card', 'account', 'comp'],
            },
            receipt_number: { type: ['string', 'null'], maxLength: 60 },
            check_number: { type: ['string', 'null'], maxLength: 60 },
            notes: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('entry.manage'),
    },
    async (request, reply) => {
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.createCheckIn(tx, request.params.org_id, request.params.rodeo_id, {
          contestant_name: b.contestant_name,
          entry_id: b.entry_id ?? null,
          contestant_id: b.contestant_id ?? null,
          member_number: b.member_number ?? null,
          fees_due_cents: b.fees_due_cents ?? 0,
          fees_paid_cents: b.fees_paid_cents ?? 0,
          payment_method: b.payment_method ?? 'cash',
          receipt_number: b.receipt_number ?? null,
          check_number: b.check_number ?? null,
          notes: b.notes ?? null,
          taken_by: request.auth!.user.user_id,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );
};
