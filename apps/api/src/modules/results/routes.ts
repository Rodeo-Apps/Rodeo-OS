/**
 * Finalising an event.
 *
 * Architecture ref: §4.1 `/finalize`.
 *
 * This is the step everything downstream depends on, and the one that was
 * missing: three places read `results` and nothing wrote it, so the average
 * payout paid nobody, the public results page was blank, and season standings
 * returned an empty list. See docs/SPEC-DELTAS.md D29.
 *
 * Results are DERIVED. Finalising twice recomputes from the scores and
 * replaces what was there — which is what makes correcting a run safe: fix
 * the score, finalise again, and the placings, the average and the points all
 * move together.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { PointsConfig } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import { finalizeEvent } from '../../core/desk-actions.ts';

export const registerResultsModule: FastifyPluginAsync = async (fastify) => {
  /**
   * POST .../events/:event_id/finalize
   *
   * `official: true` is "Make official". It is refused while any run's judge
   * card and timer sheet disagree (409, with the runs), and refused unless she
   * sends `confirm: true` — she has compared them. Computing provisional
   * placings to look at is never refused. The same finalizeEvent() call is
   * what POST /sync uses for a Make official she pressed with no signal.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: { official?: boolean; confirm?: boolean; points?: PointsConfig };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/finalize',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // Provisional by default. A secretary looks at the placings before
            // they become the thing contestants and the public are told.
            official: { type: 'boolean', default: false },
            // She has compared every judge card with its timer sheet.
            confirm: { type: 'boolean' },
            points: {
              type: 'object',
              additionalProperties: false,
              properties: {
                basis: { type: 'string', enum: ['money', 'placing', 'none'] },
                placing_points: {
                  type: 'array',
                  maxItems: 50,
                  items: { type: 'number', minimum: 0 },
                },
                counts: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const { org_id, event_id } = request.params;
      const official = request.body?.official ?? false;
      const claims = claimsFor(request.auth!);

      const out = await fastify.db.asUser(claims, (tx) =>
        finalizeEvent(tx, {
          org_id,
          rodeo_event_id: event_id,
          official,
          confirm: request.body?.confirm,
          points: request.body?.points,
        }),
      );

      if (out.kind === 'not_found') {
        return reply.status(404).send({
          error: { code: 'EVENT_NOT_FOUND', message: 'No such event.' },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'unconfirmed') {
        return reply.status(400).send({
          error: {
            code: 'CONFIRM_REQUIRED',
            message:
              'Confirm that every judge card has been compared with its timer sheet ' +
              'before making the event official.',
          },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'blocked') {
        return reply.status(409).send({
          error: {
            code: 'CARDS_DISAGREE',
            message: out.message,
            details: { blockers: out.blockers },
          },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'no_scores') {
        return reply.status(422).send({
          error: {
            code: 'NO_SCORES',
            message: 'Nothing has been scored in this event yet.',
          },
          meta: { request_id: request.id },
        });
      }
      if (out.kind === 'failed') {
        return reply.status(422).send({
          error: {
            code: 'RESULTS_FAILED',
            message: 'Results could not be computed; nothing was written.',
            details: { issues: out.issues },
          },
          meta: { request_id: request.id },
        });
      }

      if (official) {
        fastify.eventBus.emit('results.official', {
          org_id,
          rodeo_event_id: event_id,
        });
      }

      return reply.send({ data: out, meta: { request_id: request.id } });
    },
  );
};
