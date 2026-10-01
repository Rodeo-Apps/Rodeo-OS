/**
 * Day sheets.
 *
 * The paper the arena runs on. Two representations of the same computation:
 * JSON for a screen, fixed-width text for the printer in the arena office.
 *
 * The text form is not a nicety. A rodeo can lose its network, its tablets and
 * its power and still run a performance if somebody printed the sheet, and a
 * monospaced page prints identically from every browser and reads at arm's
 * length under a floodlight.
 */

import type { FastifyPluginAsync } from 'fastify';

import { buildDaySheet, renderDaySheetText, type DaySheet } from '@rodeo-os/engine';

import { claimsFor, type Tx } from '../../core/database/client.ts';
import * as ops from '../../core/database/operations-repo.ts';
import * as packetRepo from '../../core/database/packet-repo.ts';

/** The day sheet, built the one way both the screen and the packet use. */
async function daySheetFor(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  performance: number | null,
  goRounds?: number[],
): Promise<DaySheet | null> {
  const context = await ops.loadDaySheet(tx, orgId, rodeoId, performance);
  if (!context) return null;
  return buildDaySheet({
    rodeo_id: context.rodeo.id,
    rodeo_name: context.rodeo.name,
    venue: context.rodeo.venue,
    sanctioned_by: context.sanctioned_by,
    performance: {
      id: performance === null ? null : String(performance),
      name: context.performance.name,
      type: context.performance.type,
      date: context.performance.date,
      scheduled_start: context.performance.scheduled_start,
      arena_dragged_after: context.performance.arena_dragged_after,
      condensed_drag: context.performance.condensed_drag,
    },
    events: context.events,
    entries: context.entries,
    stock: context.stock,
    personnel: context.personnel,
    go_rounds: goRounds,
  });
}

export const registerDaySheetModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /rodeos/:rodeo_id/day-sheet
   *
   * ?performance=2 scopes to one performance. Omitted gives the whole rodeo,
   * which is what a secretary wants when she is checking a draw rather than
   * running a night.
   *
   * ?format=text returns the printable sheet.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
    Querystring: { performance?: string; format?: string; go_round?: string };
  }>(
    '/rodeos/:rodeo_id/day-sheet',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            performance: { type: 'string', pattern: '^[0-9]{1,3}$' },
            go_round: { type: 'string', pattern: '^[0-9]{1,2}$' },
            format: { type: 'string', enum: ['json', 'text'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;
      const performance =
        request.query.performance === undefined
          ? null
          : Number(request.query.performance);

      const sheet = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        daySheetFor(
          tx,
          org_id,
          rodeo_id,
          performance,
          request.query.go_round ? [Number(request.query.go_round)] : undefined,
        ),
      );

      if (!sheet) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }

      if (request.query.format === 'text') {
        reply.header('content-type', 'text/plain; charset=utf-8');
        return reply.send(renderDaySheetText(sheet));
      }

      return reply.send({
        data: sheet,
        meta: { request_id: request.id, total_runs: sheet.total_runs },
      });
    },
  );

  /**
   * GET /rodeos/:rodeo_id/offline-packet
   *
   * One rodeo, packed for a night with no signal: the day sheet (JSON, and
   * the existing text for every performance and the whole rodeo), the
   * entries and who has paid, the scoring config and payout config of every
   * event, the judges, the release reasons, and what is already scored.
   *
   * Read-only, and one response: the browser stores it only if all of it
   * arrived, so a half download is never something she can start a
   * performance on.
   */
  fastify.get<{ Params: { org_id: string; rodeo_id: string } }>(
    '/rodeos/:rodeo_id/offline-packet',
    async (request, reply) => {
      const { org_id, rodeo_id } = request.params;

      const packet = await fastify.db.asUser(claimsFor(request.auth!), async (tx) => {
        const rodeo = await ops.loadRodeo(tx, org_id, rodeo_id);
        if (!rodeo) return null;

        const whole = await daySheetFor(tx, org_id, rodeo_id, null);
        if (!whole) return null;

        const performances = await packetRepo.loadPacketPerformances(tx, org_id, rodeo_id);
        const sheets: { performance_number: number | null; sheet: DaySheet; text: string }[] = [
          { performance_number: null, sheet: whole, text: renderDaySheetText(whole) },
        ];
        for (const p of performances) {
          const sheet = await daySheetFor(tx, org_id, rodeo_id, p.performance_number);
          if (sheet) {
            sheets.push({
              performance_number: p.performance_number,
              sheet,
              text: renderDaySheetText(sheet),
            });
          }
        }

        return {
          packet_version: 1,
          rodeo_id,
          org_id,
          built_at: new Date().toISOString(),
          rodeo: { ...rodeo, performances },
          day_sheets: sheets,
          events: await packetRepo.loadPacketEvents(tx, org_id, rodeo_id),
          entries: await packetRepo.loadPacketEntries(tx, org_id, rodeo_id),
          scores: await packetRepo.loadPacketScores(tx, org_id, rodeo_id),
          judges: await packetRepo.loadPacketJudges(tx, org_id, rodeo_id),
          release_reasons: await packetRepo.loadReleaseReasons(tx, org_id),
        };
      });

      if (!packet) {
        return reply.status(404).send({
          error: { code: 'RODEO_NOT_FOUND', message: 'No such rodeo.' },
          meta: { request_id: request.id },
        });
      }

      return reply.send({ data: packet, meta: { request_id: request.id } });
    },
  );
};
