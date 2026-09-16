/**
 * Combining two judges' cards into one run's judged score.
 *
 * Form C is one judge per sheet. A judged event is marked by two judges who
 * each score the ride and the animal on their own card; the run's score is the
 * sum of both. This is the pure arithmetic that pairs the staged cards and
 * decides whether a run is ready to post — no I/O, no clock, so the secretary's
 * browser combines cards the same way the server does, offline in the arena.
 *
 * The animal half is summed on its own as well as into the total, because the
 * animal score feeds the stock standings independently of the rider.
 */

export interface JudgeCard {
  judge_position: number;
  judge_id?: string | null;
  rider_score: number | null;
  animal_score: number | null;
  marked_out?: boolean | null;
  /** A judge ruled the ride out (buck-off, no mark-out, flop). */
  dq_note?: string | null;
  reride_flag?: boolean | null;
  signed: boolean;
}

export interface CombinedJudgedScore {
  /** True once every required chair has a signed card. */
  complete: boolean;
  /** How many signed cards are in, and how many are needed. */
  signed_count: number;
  required_judges: number;
  /** Judge positions still missing a signed card. */
  missing_positions: number[];
  /** Null until complete. Sum of both judges' ride + animal. */
  final_score: number | null;
  /** Sum of both judges' rider halves. */
  rider_score: number | null;
  /** Sum of both judges' animal halves — feeds stock standings. */
  animal_score: number | null;
  /** True when any signed card rules the ride out; final_score is then null. */
  is_no_score: boolean;
  /** True when any signed card flags a re-ride. */
  reride: boolean;
}

/**
 * Pair the staged cards for one run and combine them.
 *
 * Only signed cards count. If any signed card marks the ride out, the run has
 * no score even if the other judge turned in numbers — a bucked-off rider does
 * not place. Positions are de-duplicated so a resubmitted card never
 * double-counts.
 */
export function combineJudgeCards(
  cards: JudgeCard[],
  requiredJudges = 2,
): CombinedJudgedScore {
  // Keep one card per chair — the last one wins, matching an upsert.
  const byPosition = new Map<number, JudgeCard>();
  for (const c of cards) byPosition.set(c.judge_position, c);
  const unique = [...byPosition.values()];

  const signed = unique.filter((c) => c.signed);
  const signedPositions = new Set(signed.map((c) => c.judge_position));
  const missing: number[] = [];
  for (let p = 1; p <= requiredJudges; p += 1) {
    if (!signedPositions.has(p)) missing.push(p);
  }

  const isNoScore = signed.some((c) => c.marked_out === true);
  const reride = signed.some((c) => c.reride_flag === true);
  const complete = missing.length === 0;

  if (!complete || isNoScore) {
    return {
      complete,
      signed_count: signed.length,
      required_judges: requiredJudges,
      missing_positions: missing,
      final_score: null,
      rider_score: null,
      animal_score: null,
      is_no_score: isNoScore,
      reride,
    };
  }

  let rider = 0;
  let animal = 0;
  for (const c of signed) {
    rider += c.rider_score ?? 0;
    animal += c.animal_score ?? 0;
  }
  // Round to two places to shed floating-point noise, same reasoning as the
  // increment check in judged.ts.
  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    complete: true,
    signed_count: signed.length,
    required_judges: requiredJudges,
    missing_positions: [],
    final_score: round2(rider + animal),
    rider_score: round2(rider),
    animal_score: round2(animal),
    is_no_score: false,
    reride,
  };
}
