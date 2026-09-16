/**
 * Form C — Riding-event judge cards.
 *
 * A judged event is marked by two judges, each working from their own sheet.
 * This module lets each judge's card be turned in on its own; the engine pairs
 * the two into a run's score. The official score still lives in the scoring
 * module — a judge card is the signed paper behind one half of it, staged so
 * the two halves do not have to be keyed in together.
 *
 * The arithmetic that combines cards is pure and tested in @rodeo-os/engine;
 * this layer validates shape, checks permission, and reads/writes the cards.
 */

import type { FastifyPluginAsync } from 'fastify';

import { combineJudgeCards, type JudgeCard } from '@rodeo-os/engine';

import { requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

/** Group flat card rows into one combined result per run for the response. */
function summarise(rows: sec.JudgeCardRow[], requiredJudges: number) {
  const byRun = new Map<string, sec.JudgeCardRow[]>();
  for (const r of rows) {
    const key = `${r.entry_id}:${r.go_round}`;
    const bucket = byRun.get(key) ?? [];
    bucket.push(r);
    byRun.set(key, bucket);
  }
  return [...byRun.values()].map((cards) => {
    const engineCards: JudgeCard[] = cards.map((c) => ({
      judge_position: c.judge_position,
      judge_id: c.judge_id,
      rider_score: c.rider_score,
      animal_score: c.animal_score,
      marked_out: c.marked_out,
      dq_note: c.dq_note,
      reride_flag: c.reride_flag,
      signed: c.signed,
    }));
    return {
      entry_id: cards[0].entry_id,
      go_round: cards[0].go_round,
      cards,
      combined: combineJudgeCards(engineCards, requiredJudges),
    };
  });
}

export const registerJudgeCardsModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /rodeos/:rodeo_id/events/:event_id/judge-cards
   *
   * Every staged card for the event, grouped into runs with the combined score
   * and which chairs are still missing a signed card.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Querystring: { go_round?: string; required_judges?: string };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/judge-cards',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            go_round: { type: 'string', pattern: '^[0-9]{1,2}$' },
            required_judges: { type: 'string', pattern: '^[1-4]$' },
          },
        },
      },
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const { org_id, event_id } = request.params;
      const goRound = request.query.go_round
        ? Number(request.query.go_round)
        : undefined;
      const requiredJudges = request.query.required_judges
        ? Number(request.query.required_judges)
        : 2;
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listJudgeCards(tx, org_id, event_id, goRound),
      );
      return reply.send({
        data: { runs: summarise(rows, requiredJudges) },
        meta: { request_id: request.id },
      });
    },
  );

  /**
   * PUT /rodeos/:rodeo_id/events/:event_id/judge-cards
   *
   * One judge turns in (or corrects) their card for a run. Keyed on the chair,
   * so a resubmission updates in place.
   */
  fastify.put<{
    Params: { org_id: string; rodeo_id: string; event_id: string };
    Body: {
      entry_id: string;
      contestant_id?: string | null;
      go_round?: number;
      performance?: number | null;
      judge_id?: string | null;
      judge_position: number;
      rider_score?: number | null;
      animal_score?: number | null;
      marked_out?: boolean | null;
      dq_note?: string | null;
      reride_flag?: boolean;
      signed?: boolean;
      notes?: string | null;
    };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/judge-cards',
    {
      schema: {
        body: {
          type: 'object',
          required: ['entry_id', 'judge_position'],
          additionalProperties: false,
          properties: {
            entry_id: { type: 'string', format: 'uuid' },
            contestant_id: { type: ['string', 'null'], format: 'uuid' },
            go_round: { type: 'integer', minimum: 1, default: 1 },
            performance: { type: ['integer', 'null'], minimum: 1 },
            judge_id: { type: ['string', 'null'], format: 'uuid' },
            judge_position: { type: 'integer', minimum: 1, maximum: 4 },
            rider_score: { type: ['number', 'null'], minimum: 0, maximum: 50 },
            animal_score: { type: ['number', 'null'], minimum: 0, maximum: 50 },
            marked_out: { type: ['boolean', 'null'] },
            dq_note: { type: ['string', 'null'], maxLength: 300 },
            reride_flag: { type: 'boolean' },
            signed: { type: 'boolean' },
            notes: { type: ['string', 'null'], maxLength: 300 },
          },
        },
      },
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const { org_id, rodeo_id, event_id } = request.params;
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertJudgeCard(tx, org_id, rodeo_id, event_id, {
          entry_id: b.entry_id,
          contestant_id: b.contestant_id ?? null,
          go_round: b.go_round ?? 1,
          performance: b.performance ?? null,
          judge_id: b.judge_id ?? null,
          judge_position: b.judge_position,
          rider_score: b.rider_score ?? null,
          animal_score: b.animal_score ?? null,
          marked_out: b.marked_out ?? null,
          dq_note: b.dq_note ?? null,
          reride_flag: b.reride_flag ?? false,
          signed: b.signed ?? false,
          notes: b.notes ?? null,
          created_by: request.auth!.user.user_id,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /** DELETE /rodeos/:rodeo_id/events/:event_id/judge-cards/:card_id */
  fastify.delete<{
    Params: { org_id: string; rodeo_id: string; event_id: string; card_id: string };
  }>(
    '/rodeos/:rodeo_id/events/:event_id/judge-cards/:card_id',
    { preHandler: requirePermission('score.correct') },
    async (request, reply) => {
      const { org_id, card_id } = request.params;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.deleteJudgeCard(tx, org_id, card_id),
      );
      if (!row) {
        return reply.status(404).send({
          error: { code: 'JUDGE_CARD_NOT_FOUND', message: 'No such card.' },
          meta: { request_id: request.id },
        });
      }
      return reply.send({ data: row, meta: { request_id: request.id } });
    },
  );
};
