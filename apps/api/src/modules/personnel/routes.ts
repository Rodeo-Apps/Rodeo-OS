/**
 * Contract-personnel sign-in — Form I (PRCA R4.13.4).
 *
 * The names of the announcer, secretary, timers, specialty acts, bullfighters,
 * barrelman, pickup men, flank man and arena director. No card numbers are
 * required on this list, and a missing sign-in has carried a $25 fine — so this
 * is a plain roster the secretary fills in and files. It is separate from the
 * carded-personnel / credentials surface under the arena module.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerPersonnelSigninModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/personnel-signins — the sign-in roster. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/personnel-signins',
    async (request, reply) => {
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listPersonnelSignins(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
        ),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /** POST /rodeos/:rodeo_id/personnel-signins — add a name to the list. */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      role: string;
      printed_name: string;
      card_or_phone?: string;
      user_id?: string;
      signature_method?: string;
      signed_at?: string;
      notes?: string;
    };
  }>(
    '/rodeos/:rodeo_id/personnel-signins',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role', 'printed_name'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', minLength: 1, maxLength: 64 },
            printed_name: { type: 'string', minLength: 1, maxLength: 120 },
            card_or_phone: { type: 'string', maxLength: 64 },
            user_id: { type: 'string', format: 'uuid' },
            signature_method: {
              type: 'string',
              enum: ['paper', 'typed', 'imported'],
            },
            signed_at: { type: 'string', format: 'date-time' },
            notes: { type: 'string', maxLength: 500 },
          },
        },
      },
      preHandler: requirePermission('personnel.manage'),
    },
    async (request, reply) => {
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.createPersonnelSignin(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
          {
            role: b.role,
            printed_name: b.printed_name,
            card_or_phone: b.card_or_phone ?? null,
            user_id: b.user_id ?? null,
            signature_method: b.signature_method ?? 'paper',
            signed_at: b.signed_at ?? null,
            notes: b.notes ?? null,
            created_by: request.auth!.user.user_id,
          },
        ),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** DELETE /rodeos/:rodeo_id/personnel-signins/:id — remove a name. */
  fastify.delete<{ Params: { org_id: string; rodeo_id: string; id: string } }>(
    '/rodeos/:rodeo_id/personnel-signins/:id',
    { preHandler: requirePermission('personnel.manage') },
    async (request, reply) => {
      const ok = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.deletePersonnelSignin(tx, request.params.org_id, request.params.id),
      );
      if (!ok) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Not on this sign-in list.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({
        data: { removed: true },
        meta: { request_id: request.id },
      });
    },
  );
};
