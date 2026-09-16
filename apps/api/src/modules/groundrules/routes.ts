/**
 * Form L — Ground rules.
 *
 * The one-page notice that has to be posted with the draw: what is sanctioned,
 * added money by event, how many performances and the slack, walk-up /
 * replacement policy, local events and any special rules, plus the committee
 * contact. Posting it stamps the time so "it was never posted" is answerable.
 *
 * One record per rodeo — get-one / put-one, with an explicit post action.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerGroundRulesModule: FastifyPluginAsync = async (fastify) => {
  /** GET /rodeos/:rodeo_id/ground-rules — the current record, or null. */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/ground-rules',
    { preHandler: requirePermission('rodeo.edit') },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.getGroundRules(tx, request.params.org_id, request.params.rodeo_id),
      );
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * PUT /rodeos/:rodeo_id/ground-rules — create or update. Pass post:true to
   * stamp the posting time and posting user.
   */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string };
    Body: sec.GroundRulesInput;
  }>(
    '/rodeos/:rodeo_id/ground-rules',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            city_state: { type: ['string', 'null'], maxLength: 120 },
            sanction: { type: ['string', 'null'], maxLength: 120 },
            added_money_by_event: { type: ['string', 'null'], maxLength: 2000 },
            performances_note: { type: ['string', 'null'], maxLength: 1000 },
            slack_note: { type: ['string', 'null'], maxLength: 1000 },
            walkup_replacement: { type: 'boolean' },
            local_events: { type: ['string', 'null'], maxLength: 2000 },
            special_rules: { type: ['string', 'null'], maxLength: 4000 },
            committee_contact: { type: ['string', 'null'], maxLength: 200 },
            post: { type: 'boolean' },
          },
        },
      },
      preHandler: requirePermission('rodeo.edit'),
    },
    async (request, reply) => {
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertGroundRules(tx, request.params.org_id, request.params.rodeo_id, {
          ...request.body,
          posted_by: request.auth!.user.user_id,
          created_by: request.auth!.user.user_id,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );
};
