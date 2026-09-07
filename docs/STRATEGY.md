# Rodeo Apps Ecosystem Strategy

*How RodeoApps.pro OS (the producer platform) and the eight discipline athlete
apps become one product line rather than nine unrelated codebases.*

Last updated: 7 September 2026.

---

## 1. The two halves of one market

Rodeo has two customers who never share software today:

1. **The producer side** — the producer, secretary, judge, timer operator and
   stock contractor who *run* a rodeo. Entries, draw, scoring, results, payouts,
   waivers and settlement. This is what **RodeoApps.pro OS** (this repository)
   already does: 45 tables, RLS, immutability triggers, association profiles and
   a settlement engine that computes money rather than storing it.

2. **The athlete side** — the contestant who *competes*. Logging runs, reviewing
   technique on video, tracking standings, finding events, and improving. This is
   what the **eight discipline mobile apps** do, one per event so the language,
   scoring and coaching are native to that event rather than a generic "rodeo app":

   | App | Event | Scoring model |
   |-----|-------|---------------|
   | Tie-Down Roping | Timed | Fastest time, barrier/penalty aware |
   | Breakaway Roping | Timed | Fastest time, string-break stop |
   | Team Roping | Timed | Header + heeler, 5s leg penalty |
   | Steer Wrestling (Bulldogging) | Timed | Fastest time |
   | Saddle Bronc | Judged | Rider + animal, spur-out marked |
   | Bareback Bronc | Judged | Rider + animal, rigging technique |
   | Bull Riding (BullRider) | Judged | Rider + animal, 8-second qualification |
   | Ranch Rodeo | Team/mixed | Multi-event aggregate |

The strategic bet is simple: **the same schema and the same accounts serve both
halves.** A run scored by a secretary in the producer OS is the run an athlete
reviews in their discipline app. That shared spine is the moat — nobody else owns
both the producing system of record and the athlete's daily habit.

---

## 2. Shared platform, not shared app

The eight apps are deliberately *separate* apps (separate store listings, separate
bundle IDs, separate branding) sitting on **one shared platform layer**:

- **Auth** — Supabase email/password, one identity across every app and the OS.
  An athlete who competes in two events installs two apps but has one account,
  one profile, one purchase history.
- **Data** — one Supabase Postgres project family. The athlete apps read the same
  `profiles`, event and results structures the OS writes. Discipline-specific run
  data lives in a per-app `*_runs` table so each event keeps its native fields
  without polluting the others.
- **Monetization** — **RevenueCat** for consumer subscriptions in every mobile
  app, gated behind a single entitlement, `rodeo_apps_premium`. Store billing
  (App Store / Play) is the only path for recurring consumer subscriptions, which
  keeps the apps compliant and removes the "external purchase" review risk.
- **AI** — one analysis platform (Supabase edge functions calling OpenAI Vision,
  `gpt-4o`) with a per-discipline scoring rubric. Premium-gated. The producer OS
  can reuse the same functions for judge-assist and highlight generation.

This is the Procore/Toast pattern the [MODEL.md](MODEL.md) already argues for,
extended to the athlete: **verticalized apps on a horizontal platform.** The
platform is the asset; the apps are distribution.

---

## 3. Monetization architecture

Three revenue streams, cleanly separated so store policy never collides with
producer billing:

1. **Consumer subscriptions (athlete apps) — RevenueCat.**
   `rodeo_apps_premium` unlocks video analysis, advanced stats, full standings and
   unlimited run history. Priced per app (monthly / annual) through native store
   billing. RevenueCat gives us cross-store entitlements, restore-purchase
   compliance, and a single webhook to sync `premium_status` onto the profile.

2. **Producer subscriptions (the OS) — tiered, Stripe.**
   Free → $299/mo producer tiers as set out in [PRICING.md](PRICING.md), billed
   through Stripe because these are B2B web subscriptions outside the app stores.

3. **One-off / marketplace payments — Stripe.**
   Non-subscription purchases (event entry fees, marketplace, sponsor
   transactions) stay on Stripe. **BullRider is the reference implementation of
   this split:** its subscription flow was moved to RevenueCat while its Stripe
   `create-checkout` path is retained *only* for one-off, non-subscription
   purchases. No mobile app takes a recurring subscription through Stripe.

The rule that keeps us out of trouble: **recurring consumer subscription →
RevenueCat; producer B2B subscription and one-off → Stripe.** Never the reverse.

---

## 4. The AI analysis platform

Premium video analysis is the single most defensible consumer feature, because it
depends on data nobody else has: the run, the score, the animal draw and the
athlete's history all in one place.

- **Delivery** — Supabase edge functions (`analyze-video`, `analyze-team-video`)
  call OpenAI Vision (`gpt-4o`) with a strict JSON schema per discipline. Timed
  events score the catch/barrier/run; judged events (bronc, bareback, bull) score
  rider technique against the marks a judge actually uses — spur-out, free-arm
  control, body position, timing.
- **Gating** — every function verifies `premium_status` server-side before
  spending a token. The client never decides entitlement.
- **Storage** — structured results persist to the app's analysis table so
  progress is trackable over time, and so the same result can surface to a coach
  or, later, feed judge-assist in the OS.
- **Reuse** — because the rubric is per-discipline and server-side, the producer
  OS can call the identical function for highlight tagging and result QA without a
  second model integration.

The strategic point: AI is not a feature bolted onto eight apps; it is one
platform service the whole ecosystem shares.

---

## 5. Data flow: one run, two views

The end-to-end loop that only this ecosystem can close:

```
Producer OS                         Athlete app
-----------                         -----------
Secretary opens entries    ───────▶ Athlete enters event from the app
Draw is made               ───────▶ Athlete sees their draw + animal
Judge/timer records run    ───────▶ Run appears in athlete history
Results posted             ───────▶ Standings update live
Settlement computes payout ───────▶ Athlete sees winnings
                            ◀─────── Athlete uploads video → AI analysis
```

Every arrow is a shared-schema read or write, not an integration. That is the
difference between a suite and a platform, and it is why the eight apps and the OS
must share Supabase from day one rather than being reconciled later.

---

## 6. Build sequencing

1. **Platform primitives first** *(done / in progress).* Shared auth context, IAP
   service, premium gate, profile and premium screens, and the AI edge-function
   pattern are built once and distributed to every discipline app so the apps stay
   consistent and cheap to maintain.
2. **Eight discipline apps to parity.** Each app ships auth, run logging with its
   native scoring engine, standings, premium gate and premium-gated AI analysis on
   the shared platform. Separate store presence, shared backend.
3. **OS ↔ app data bridge.** Wire the athlete apps to read producer-written events,
   draws and results, and to write entries back — turning the diagram in §5 from
   aspiration into product.
4. **Judge-assist and highlights in the OS**, reusing the consumer AI platform.

---

## 7. Why this wins

- **Distribution flywheel.** Producers bring their contestants onto the platform
  to enter and get paid; those contestants are the exact audience for the athlete
  apps. Athlete apps, in turn, make a producer's rodeo the easy one to enter.
- **One system of record.** Competitors own either the producing software *or* an
  athlete app, never both. Owning the run from entry to payout to video review is
  the durable advantage.
- **Cost discipline.** One auth, one schema family, one billing split, one AI
  platform. Eight apps do not mean eight backends — they mean eight front doors to
  one house.
- **Compliance by design.** The RevenueCat/Stripe split is drawn so consumer
  subscriptions are always store-billed and producer/one-off flows are always
  Stripe, removing the most common app-review rejection before it happens.

---

## 8. Open questions to resolve next

- **Account linking UX** across multiple installed discipline apps (single
  sign-on vs. per-app login with shared credentials).
- **Cross-app premium** — does `rodeo_apps_premium` entitle one app or the whole
  suite? A suite-wide entitlement is a stronger offer but needs a store-billing and
  RevenueCat-offering design that spans products.
- **Data residency and RLS** boundaries between producer-owned event data and
  athlete-owned run data when both live in one project.
- **AI cost ceiling** per premium user per month, and the frame-sampling strategy
  that keeps `gpt-4o` spend predictable at scale.

These are decisions, not blockers — the platform is architected so each can be
answered without re-laying the foundation.
