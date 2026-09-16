/**
 * Association packet / upload — Form M checklist side.
 *
 * Each sanctioning association wants a specific set of sheets sent in by a
 * specific deadline. The engine holds the per-association checklist and the
 * deadline rule; this surface stores which items the secretary has gathered and
 * reports what is still missing and how long is left to file.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  associationPacketDeadline,
  checkPacket,
  requiredPacketItems,
  type PacketItemCode,
} from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

/**
 * packet_items is stored as a map of item code -> gathered flag. Pull out the
 * codes the secretary marked present so the engine can check the list.
 */
function haveCodes(packet: Record<string, unknown>): PacketItemCode[] {
  return Object.entries(packet)
    .filter(([, present]) => present === true)
    .map(([code]) => code as PacketItemCode);
}

export const registerAssociationUploadModule: FastifyPluginAsync = async (
  fastify,
) => {
  /**
   * GET /rodeos/:rodeo_id/association-upload — the stored packet plus a live
   * checklist (what this association requires, what is missing) and the stored
   * deadline.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
  }>('/rodeos/:rodeo_id/association-upload', async (request, reply) => {
    const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
      sec.getAssociationUpload(
        tx,
        request.params.org_id,
        request.params.rodeo_id,
      ),
    );
    if (!row) {
      return reply.send({ data: null, meta: { request_id: request.id } });
    }
    const check = checkPacket(
      row.association_code,
      haveCodes(row.packet_items ?? {}),
    );
    return reply.send({
      data: {
        upload: row,
        required_items: requiredPacketItems(row.association_code),
        check,
      },
      meta: { request_id: request.id },
    });
  });

  /**
   * POST /rodeos/:rodeo_id/association-upload — start the packet for an
   * association. Computes and stores the filing deadline from the last
   * performance date.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      association_code: string;
      method?: string;
      packet_items?: Record<string, boolean>;
      last_performance_date?: string;
      timezone?: string | null;
      notes?: string | null;
    };
  }>(
    '/rodeos/:rodeo_id/association-upload',
    {
      schema: {
        body: {
          type: 'object',
          required: ['association_code'],
          additionalProperties: false,
          properties: {
            association_code: { type: 'string', maxLength: 40 },
            method: { type: 'string', maxLength: 40 },
            packet_items: { type: 'object' },
            last_performance_date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            timezone: { type: ['string', 'null'], maxLength: 60 },
            notes: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
      },
      preHandler: requirePermission('books.close'),
    },
    async (request, reply) => {
      const b = request.body;
      let deadlineAt: string | null = null;
      if (b.last_performance_date) {
        const deadline = associationPacketDeadline({
          association: b.association_code,
          last_performance_date: b.last_performance_date,
          now_ms: Date.now(),
          timezone: b.timezone ?? null,
        });
        deadlineAt = deadline.due_at;
      }
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.createAssociationUpload(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
          {
            association_code: b.association_code,
            method: b.method,
            packet_items: b.packet_items ?? {},
            deadline_at: deadlineAt,
            notes: b.notes ?? null,
            created_by: request.auth!.user.user_id,
          },
        ),
      );
      return reply
        .status(201)
        .send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * PUT /rodeos/:rodeo_id/association-upload/:id — update the gathered items,
   * status, or submission reference. Recomputes the deadline when a new last
   * performance date is supplied.
   */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string; id: string };
    Body: {
      packet_items?: Record<string, boolean>;
      status?: string;
      submitted_at?: string | null;
      submission_reference?: string | null;
      last_performance_date?: string;
      timezone?: string | null;
      association_code?: string;
      notes?: string | null;
    };
  }>(
    '/rodeos/:rodeo_id/association-upload/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            packet_items: { type: 'object' },
            status: {
              type: 'string',
              enum: ['gathering', 'ready', 'submitted', 'accepted'],
            },
            submitted_at: { type: ['string', 'null'], format: 'date-time' },
            submission_reference: { type: ['string', 'null'], maxLength: 200 },
            last_performance_date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
            timezone: { type: ['string', 'null'], maxLength: 60 },
            association_code: { type: 'string', maxLength: 40 },
            notes: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
      },
      preHandler: requirePermission('books.close'),
    },
    async (request, reply) => {
      const b = request.body;
      let deadlineAt: string | null = null;
      if (b.last_performance_date && b.association_code) {
        deadlineAt = associationPacketDeadline({
          association: b.association_code,
          last_performance_date: b.last_performance_date,
          now_ms: Date.now(),
          timezone: b.timezone ?? null,
        }).due_at;
      }
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.updateAssociationUpload(
          tx,
          request.params.org_id,
          request.params.id,
          {
            packet_items: b.packet_items,
            status: b.status,
            submitted_at: b.submitted_at ?? null,
            submission_reference: b.submission_reference ?? null,
            deadline_at: deadlineAt,
            notes: b.notes ?? null,
          },
        ),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Upload not found.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );
};
