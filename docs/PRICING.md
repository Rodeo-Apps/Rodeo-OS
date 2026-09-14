# Pricing

Last modelled: **14 September 2026**

Every number here is produced by `packages/engine/src/pricing/engine.ts` and
held by the pricing tests. Change a rate and the tests tell you whether you are
still cheaper than the competition — the business model is executable, not a
spreadsheet somebody has to remember to update.

---

## The model in one paragraph

**The OS is free to producers. We take nothing on the money — Stripe at cost,
zero markup. One membership, Rodeo Apps Premium at $4.99/mo or $49.99/yr,
unlocks premium across all the athlete apps and the OS.** Give the tooling
away, capture the market, adjust in about three years. That is the whole thing.

Everything below explains why each piece is set the way it is, and keeps the
old percentage model on the shelf as a comparison and a possible future lever.

---

## What the field actually charges

Not an estimate. Published rates, all-in on a $100 entry:

| Platform | Headline | Card processing | All-in on a $100 entry |
|---|---|---|---|
| **RodeoReady** | 5.5% + $0.35, paid by the contestant | **Included** | **$5.85** |
| **38 Arena** | ~4% + $0.80 online, paid by the rider | On top | **~$5.10** |
| **Rodeo Producer** | 1% admin fee | On top (~2.9% + $0.30) | **$4.23** |
| **Rodeo Apps** | **0% — Stripe at cost** | On top | **$3.20** |

**The whole field already gives the software away and taxes the contestant.**
Charging producers a licence fee is not an option — it is a reason to be
ignored. So we do not charge the producer, and we go one step further than
anyone else: **we take nothing on the entry either.**

### The mistake this model caught

An early draft set a rate of 4.9% + $0.30, reasoning that it "undercuts
RodeoReady's 5.5%." Modelled properly that is **$8.55 all-in** — half again
more expensive than the competitor it was meant to beat, because RodeoReady's
5.5% *includes* card processing and ours would have stacked on top of it.

Comparing headline rates across platforms that treat processing differently is
exactly how a company prices itself out of a market it thinks it is winning.
`compareAllIn()` exists so that cannot happen again, and a test asserts we are
cheaper than RodeoReady at every entry size from $25 to $500. At a 0% platform
fee that is never close.

---

## Leg 1 — The OS is free to the producer

Everything needed to run a rodeo: events, entries, draw, stock draw, scoring,
results, payouts, settlement, day sheets, public results page. No per-rodeo
fee, no seat fee, no setup fee, no minimum.

This is not generosity. Committees are volunteer-run and price-sensitive, the
competition is already at zero, and **the producer is not the customer — they
are the distribution channel.** Every rodeo run on the platform puts its whole
field of contestants into the apps.

38 Arena — the closest competitor with a real producer back-office — charges
$40/mo or $400/yr *plus* transaction fees. Free is the wedge.

---

## Leg 2 — We take nothing on the money

**Stripe at cost. Zero platform markup.** A $100 entry costs the contestant
**$103.20** — card processing only — and every cent of the $100 reaches the
producer. This is set in the engine as `DEFAULT_PLATFORM_FEES`: every rate is
zero.

Taking nothing does three things no percentage can:

1. **It works on cash rodeos.** A jackpot run out of a cash box pays a
   percentage model nothing anyway. Our model does not depend on how the money
   moved, so a large share of ropings and small rodeos are covered on day one.
2. **It is the cheapest entry in the country.** $103.20 all-in, for everyone,
   not just members. That is a producer's argument to their own field, not just
   ours to them.
3. **It removes the hardest sales conversation there is** — explaining a cut of
   every entry to a volunteer committee secretary.

### The one cost to watch

At zero take on the money flow, the platform still carries the **operational
cost and risk of being in the payment path** — chargebacks, disputes,
connected-account onboarding, and reporting obligations as the facilitator. If
that proves expensive, a small **flat** per-transaction fee (cents, not a
percentage) preserves the "no percentage" position while covering it. Worth
confirming with an accountant before launch rather than assuming.

---

## Leg 3 — One membership pays for everything

**Rodeo Apps Premium: $4.99/mo or $49.99/yr.** One price. It unlocks premium
across every athlete app *and* the OS. Held in the engine as
`RODEOAPPS_SUBSCRIPTION` (499 / 4999 cents).

There is one brand — Rodeo Apps. Sign up for one app and you have access to all
of them on one login, and one membership carries everywhere you go. A barrel
racer, a bull rider and a team roper pay the same $4.99 and each gets the full
depth of their own discipline plus the shared social network.

Sold honestly it is: every app for one price, the draw in your pocket, live
results, your whole career record, season earnings and standings, and the
community for your event. That is a consumer product at Spotify money — and
because there is no per-entry fee to avoid, the pitch does **not** depend on a
contestant entering enough rodeos for arithmetic to work. The weekend roper who
would never clear a fee break-even is a legitimate customer, not somebody being
sold a discount they will not use.

Cross-platform entitlement is handled by RevenueCat, so one purchase is
recognised on iOS, Android and web across the whole app family.

---

## What the OS makes possible for the apps

This is the part no competitor can copy quickly, because they have no consumer
membership and no reason to build one.

### The OS makes the apps worth paying for

Without it the apps are social apps with nothing in them. With it, every app
holds the things a contestant actually wants:

- **Their draw**, pushed the moment the secretary commits it
- **Live results** as the rodeo runs — public by policy, name and time only
- **Their career record** — every run, every time, every score, every cheque,
  kept privately to the athlete
- **Season standings and earnings**, computed from real results
- **The cheapest entry in the sport** at every rodeo on the platform

None of that is available to a contestant whose rodeos are not on the OS. The
app is only as good as the data behind it, and the OS is the data.

### The apps make producers adopt the OS

A producer switches software for one of two reasons: it is cheaper, or it is
where the contestants are. The apps deliver both.

- **"Your ropers pay less here."** A producer moving off RodeoReady can tell
  their field they will pay $3.20 instead of $5.85. That is a switching
  argument with no software features in it at all.
- **Entries arrive.** Contestants already in an app see the rodeo, get the
  reminder, and enter in two taps against a saved profile.
- **Front door per discipline.** A bull rider finds the rodeo through the bull
  riding app; a barrel racer through hers. The producer lists once.

### The loop

```
  Producer runs a rodeo free on the OS
            │
            ▼
  Their whole field lands in the apps (draw, results, earnings)
            │
            ▼
  Contestants join Rodeo Apps Premium — every app plus their career record
            │
            ▼
  Members concentrate on rodeos that are ON the platform
            │
            ▼
  Producers adopt the OS to reach them  ──┐
            ▲                              │
            └──────────────────────────────┘
```

Procore ran the same loop: free for subcontractors, paid for the GC, and the
subs became the reason every GC needed it. The rodeo version inverts who pays —
the producer is free and the contestant subscribes — because in rodeo the
contestants outnumber the producers by three orders of magnitude and they are
the ones already being charged.

---

## Break-even on the membership

Because the platform fee is zero, the membership does not have to "pay for
itself" in avoided fees — it is a consumer product. But for anyone who wants
the arithmetic against the *old* percentage model, `subscriptionBreakEven()`
still runs it against any fee config you hand it. Against the deferred 2% model,
$49.99/year breaks even at:

| Average entry | Saved per entry (2% model) | Entries a year to break even |
|---|---|---|
| $50 | $1.00 | 50 |
| $100 | $2.00 | 25 |
| $150 | $3.00 | 17 |
| $300 | $6.00 | 9 |

Under today's zero-fee model there is nothing to save on fees, so the tests
assert this honestly: with pass-through pricing the break-even is infinite and
the per-entry saving is zero. **The membership is sold on the apps, not on a
fee dodge.**

---

## Deferred: the percentage model (comparison only)

Kept in the engine as `PERCENTAGE_MODEL_FEES` — **2.0% capped at $15,
subscribers zero** — and retained here for two reasons: so `compareModels()`
can show a producer what a cut *would* have taken, and as a possible year-3
lever once the market is captured. **It is not what the platform charges
today.**

| Entry | 2% non-member would pay | 2% member would pay |
|---|---|---|
| $50 | $2.78 | $1.75 |
| $100 | $5.26 | $3.20 |
| $150 | $7.74 | $4.65 |
| $300 | $15.17 (capped) | $9.00 |

If we ever turn a percentage back on, the rate and the membership have to be
designed together: at the 4.9% an early draft proposed, converting a heavy user
to a member would cost ~40% of revenue; at 2% that trade is close to free.

---

## Deferred: the producer ladder (comparison only)

An earlier version of this document recommended a five-rung producer
subscription ladder (Grassroots free → Association $299/mo). It is kept in the
engine as `PRODUCER_PLANS` and modelled by tests, but **it is not the plan.**
The current model gives the OS away to every producer and monetises on the
single athlete membership instead. The ladder stays on the shelf as a year-3
option if we ever decide to charge large operators for advanced OS capability.

| Plan | Price | Entries/yr | What it added |
|---|---|---|---|
| **Grassroots** | Free | ≤ 100 | Events, entries, contestants, results, waivers |
| **Club** | $9.99/mo · $99.90/yr | ≤ 500 | + scoring, payouts |
| **Starter** | $29.99/mo · $299.90/yr | ≤ 1,500 | + sidepots |
| **Pro** | $99/mo · $990/yr | ≤ 10,000 | + timer, broadcast, stock, analytics |
| **Association** | $299/mo · $2,990/yr | unlimited | + multi-rodeo series, tax reporting |

---

## Open questions worth deciding before launch

1. **Flat per-transaction cost recovery.** If being in the payment path proves
   expensive (chargebacks, disputes, facilitator reporting), a few cents flat
   per transaction covers it without breaking the "no percentage" position.
   Confirm with an accountant.
2. **Association bulk memberships.** A state association buying memberships for
   its whole roster is worth more than the same conversions one at a time, and
   it makes the association the salesforce. Needs a channel price.
3. **What, if anything, is OS premium.** Today the OS is free end to end. If we
   want a paid OS tier later, it should be advanced capability a big operator
   would pay for (multi-rodeo series, deep analytics, priority support) — not a
   gate on anything needed to run a rodeo. See the ecosystem architecture doc.
4. **Stripe Connect pricing tier.** 2.9% + $0.30 is standard. At volume this is
   negotiable, and every basis point comes straight off what a contestant pays.
