/**
 * Two-timer sheet — Form D.
 *
 * Every timed run is caught on two watches, and often an electric eye. The
 * engine reconciles them into one official time by a fixed rule so a contestant
 * cannot argue the office rounded against them. This surface records each watch
 * and then runs the reconciliation, writing the official time back onto the
 * readings for the run.
 */

import type { FastifyPluginAsync } from 'fastify';

import { reconcileTimers } from '@rodeo-os/engine';

import { isUuid, requirePermission } from '../../core/auth.ts';
import { claimsFor } from '../../core/database/client.ts';
import * as sec from '../../core/database/secretary-repo.ts';

export const registerTimersModule: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /rodeos/:rodeo_id/timer-readings — the raw watches.
   * Optional ?event_id= narrows to one event.
   */
  fastify.get<{
    Params: { org_id: string; rodeo_id: string };
    Querystring: { event_id?: string };
  }>(
    '/rodeos/:rodeo_id/timer-readings',
    async (request, reply) => {
      const eventId = request.query.event_id ?? null;
      if (eventId && !isUuid(eventId)) {
        return reply.status(400).send({
          error: { code: 'BAD_ID', message: 'event_id must be a uuid.' },
          meta: { request_id: request.id },
        });
      }
      const rows = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.listTimerReadings(
          tx,
          request.params.org_id,
          request.params.rodeo_id,
          eventId,
        ),
      );
      return reply.send({ data: rows, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/timer-readings — record one watch for one run.
   * Re-recording the same timer for the same run updates it in place.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      rodeo_event_id: string;
      timer_number: 1 | 2;
      entry_id?: string;
      performance_number?: number;
      run_position?: number;
      raw_seconds?: number;
      barrier_penalty_seconds?: number;
      field_seconds?: number;
      electric_eye?: boolean;
      no_time?: boolean;
      turnout?: boolean;
      flag_note?: string;
    };
  }>(
    '/rodeos/:rodeo_id/timer-readings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rodeo_event_id', 'timer_number'],
          additionalProperties: false,
          properties: {
            rodeo_event_id: { type: 'string', format: 'uuid' },
            timer_number: { type: 'integer', enum: [1, 2] },
            entry_id: { type: 'string', format: 'uuid' },
            performance_number: { type: 'integer', minimum: 0 },
            run_position: { type: 'integer', minimum: 0 },
            raw_seconds: { type: 'number', minimum: 0, maximum: 9999.999 },
            barrier_penalty_seconds: { type: 'number', minimum: 0, maximum: 999.999 },
            field_seconds: { type: 'number', minimum: 0, maximum: 9999.999 },
            electric_eye: { type: 'boolean' },
            no_time: { type: 'boolean' },
            turnout: { type: 'boolean' },
            flag_note: { type: 'string', maxLength: 200 },
          },
        },
      },
      preHandler: requirePermission('score.submit'),
    },
    async (request, reply) => {
      const b = request.body;
      const row = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
        sec.upsertTimerReading(tx, request.params.org_id, request.params.rodeo_id, {
          rodeo_event_id: b.rodeo_event_id,
          entry_id: b.entry_id ?? null,
          performance_number: b.performance_number ?? null,
          run_position: b.run_position ?? null,
          timer_number: b.timer_number,
          raw_seconds: b.raw_seconds ?? null,
          barrier_penalty_seconds: b.barrier_penalty_seconds ?? 0,
          field_seconds: b.field_seconds ?? null,
          electric_eye: b.electric_eye ?? false,
          no_time: b.no_time ?? false,
          turnout: b.turnout ?? false,
          flag_note: b.flag_note ?? null,
          recorded_by: request.auth!.user.user_id,
        }),
      );
      return reply.status(201).send({ data: row, meta: { request_id: request.id } });
    },
  );

  /**
   * POST /rodeos/:rodeo_id/timer-readings/reconcile
   *
   * Reconcile a run: pass the two watches (and the eye, and any penalty) and
   * get the official time. When entry_id / performance_number / run_position
   * are given, the official time is written back onto the readings for the run.
   */
  fastify.post<{
    Params: { org_id: string; rodeo_id: string };
    Body: {
      rodeo_event_id: string;
      entry_id?: string;
      performance_number?: number;
      run_position?: number;
      timer1_seconds?: number | null;
      timer2_seconds?: number | null;
      electric_eye_seconds?: number | null;
      barrier_penalty_seconds?: number;
      other_penalty_seconds?: number;
      no_time?: boolean;
      turnout?: boolean;
      discrepancy_threshold_seconds?: number;
      persist?: boolean;
    };
  }>(
    '/rodeos/:rodeo_id/timer-readings/reconcile',
    {
      schema: {
        body: {
          type: 'object',
          required: ['rodeo_event_id'],
          additionalProperties: false,
          properties: {
            rodeo_event_id: { type: 'string', format: 'uuid' },
            entry_id: { type: 'string', format: 'uuid' },
            performance_number: { type: 'integer', minimum: 0 },
            run_position: { type: 'integer', minimum: 0 },
            timer1_seconds: { type: ['number', 'null'], minimum: 0, maximum: 9999.999 },
            timer2_seconds: { type: ['number', 'null'], minimum: 0, maximum: 9999.999 },
            electric_eye_seconds: { type: ['number', 'null'], minimum: 0, maximum: 9999.999 },
            barrier_penalty_seconds: { type: 'number', minimum: 0, maximum: 999.999 },
            other_penalty_seconds: { type: 'number', minimum: 0, maximum: 999.999 },
            no_time: { type: 'boolean' },
            turnout: { type: 'boolean' },
            discrepancy_threshold_seconds: { type: 'number', minimum: 0, maximum: 60 },
            persist: { type: 'boolean' },
          },
        },
      },
      preHandler: requirePermission('score.correct'),
    },
    async (request, reply) => {
      const b = request.body;
      const result = reconcileTimers({
        timer1_seconds: b.timer1_seconds,
        timer2_seconds: b.timer2_seconds,
        electric_eye_seconds: b.electric_eye_seconds,
        barrier_penalty_seconds: b.barrier_penalty_seconds,
        other_penalty_seconds: b.other_penalty_seconds,
        no_time: b.no_time,
        turnout: b.turnout,
        discrepancy_threshold_seconds: b.discrepancy_threshold_seconds,
      });

      let written = 0;
      if (b.persist) {
        written = await fastify.db.asUser(claimsFor(request.auth!), (tx) =>
          sec.writeOfficialTime(
            tx,
            request.params.org_id,
            b.rodeo_event_id,
            b.performance_number ?? null,
            b.run_position ?? null,
            b.entry_id ?? null,
            result.official_seconds,
          ),
        );
      }

      return reply.send({
        data: result,
        meta: { request_id: request.id, readings_updated: written },
      });
    },
  );
};
