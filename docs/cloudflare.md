# The Cloudflare deployment — architecture and cost drivers

Spike for the plan's PR B (simple-games `docs/plans/2026-09-30-public-club-house.md`,
issue simple-games-club#1). The question it answers is the one that decides whether a
Public Club House exists at all: **can one deployment of this server run on Cloudflare's
free plan, with the same club.md §5 contract as the Node server?** The contract part is
answered here by tests. The cost part is answered here only as far as a local runtime
can: every number below is either quoted from Cloudflare's documentation with its date,
or measured in workerd on a laptop. **Nothing has been deployed yet, and no amount of
money is written in this document** — simple-games `docs/PRODUCT_PRINCIPLES.md`「費用の上限」
forbids writing a figure before it is measured, and §7 is where the measured one goes.

## 1. What runs where

```text
client ──HTTPS──▶ Worker (src/worker/index.ts)
                    │  names the client (CF-Connecting-IP), builds the origin,
                    │  forwards /api/* ; serves the web build from the assets binding
                    ▼
                  Durable Object `ClubObject` — one per deployment, named "club"
                    │  createApi(...)          the same src/http/api.ts as Node
                    │  Store(sqlDriver(...))   the same src/db/store.ts as Node
                    ▼
                  the object's own SQLite (ctx.storage.sql), persisted by Cloudflare
```

- **One deployment is one club** (club.md §1), so one object. Its name is the shard
  key and nothing else knows it: a deployment that one day needs more than one object
  changes how the Worker derives the name, not the contract. This is what the issue
  asked for — "one public room, but not necessarily one permanent singleton internally".
- **What is shared with the Node server**: every route, check, status code and SQL
  statement (`src/api/*`, `src/http/api.ts`, `src/http/{router,errors,cors,body,
rateLimit}.ts`, `src/validate.ts`, `src/limits.ts`, `src/contracts/games.ts`,
  `src/auth/tokens.ts`, `src/db/{schema,store,driver}.ts`). **What is not**: how a
  request reaches that code (`src/app.ts` on Node, `src/worker/index.ts` here) and how
  SQL reaches the engine (`src/db/database.ts`, `src/worker/driver.ts`). The proof of
  sameness is not this list but the tests: `pnpm test` runs the contract tests against
  both deployments (`vitest.config.ts`), and both pass all of them.
- **Static files**: the web build goes in `web/`; hashed assets are served by the assets
  binding before the Worker runs, at no charge. Only `/api/*` and the entry pages
  (`/`, `/index.html`, `/join`, `/join/`) reach the Worker (`wrangler.toml`).
- **Secrets**: `CLUB_SETUP_KEY` and (optionally) `CLUB_SECRET` are Worker secrets.
  Without `CLUB_SECRET` the object generates one into its own storage on first use —
  the Node server does the same on its volume.
- **Rate limits** are counted inside the object, in memory, with the Node server's
  code (`src/http/rateLimit.ts`): the object is one process for its club, so the count
  is exact while it is alive; an eviction forgets at most the last minute.
- **Logs**: the object writes one `console.error` per 500 and nothing per request.
  Workers Logs is enabled for the dashboard's sake (`[observability]`).

## 2. The free plan, from the primary sources

Read on 2026-10-01 from developers.cloudflare.com. Quote marks are the documentation's
words; what happens past a limit is quoted too, because that is the cost ceiling.

| Resource                | Workers Free                                 | Past the limit (Free)                                                       | Workers Paid (US$5/month)                                               | Source                                            |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Worker requests         | "100,000 per day"                            | "Error 1027" (fail closed), "resetting at midnight UTC"                     | "10 million included per month", "+$0.30 per additional million"        | workers/platform/pricing, workers/platform/limits |
| Worker CPU time         | "10 milliseconds of CPU time per invocation" | the request fails                                                           | "30 million CPU milliseconds included", "+$0.02 per additional million" | workers/platform/pricing                          |
| Durable Object requests | "100,000 / day"                              | "further operations of that type will fail with an error"                   | "1 million / month, + $0.15/million"                                    | durable-objects/platform/pricing                  |
| Durable Object duration | "13,000 GB-s / day"                          | same                                                                        | "400,000 GB-s / month, + $12.50/million GB-s"                           | durable-objects/platform/pricing                  |
| SQLite rows read        | "5 million / day"                            | same                                                                        | "First 25 billion / month included + $0.001 / million rows"             | durable-objects/platform/pricing                  |
| SQLite rows written     | "100,000 / day"                              | same                                                                        | "First 50 million / month included + $1.00 / million rows"              | durable-objects/platform/pricing                  |
| SQLite stored data      | "5 GB (total)"                               | same                                                                        | "5 GB-month, + $0.20/ GB-month"                                         | durable-objects/platform/pricing                  |
| Static asset requests   | "free and unlimited"                         | — (paths in `run_worker_first` are Worker requests and get a 429 past that) | same                                                                    | workers/static-assets/billing-and-limitations     |
| Egress                  | "no additional charges for data transfer"    | —                                                                           | same                                                                    | workers/platform/pricing                          |
| Workers Logs            | "200,000 per day", "3 Days" retention        | logs are dropped                                                            | "20 million included per month", "$0.60 per additional million"         | workers/observability/logs/workers-logs           |

Other facts the design rests on, same date:

- "Workers Free plan can only create and access SQLite-backed Durable Objects" — which is
  the backend this server wants anyway (`new_sqlite_classes`). "Storage type is
  immutable once a namespace exists."
- SQLite storage billing on Durable Objects "will be enabled in January 2026"; it is in
  force at the time of writing, so the rows-read/written quotas above are live limits.
- "An individual Object has a soft limit of 1,000 requests per second." Storage per
  object: 10 GB. SQL statement: 100 KB. Row: 2 MB.
- Duration is billed "while actively running or … idle in memory but unable to
  hibernate", at "128 MB of memory" per object. One object awake for a whole day is
  24 × 3600 × 0.125 = **10,800 GB-s**, under the day's 13,000 — a one-object deployment
  cannot run out of duration, however busy; a many-object one adds them up.
- `node:crypto` is "fully supported" under `nodejs_compat`, which the token code uses
  for `createHash` and `timingSafeEqual`.
- The Rate Limiting binding exists (`ratelimits`, period 10 or 60 s) but is "permissive,
  eventually consistent" and per location, and its page states no price. The spike does
  not use it; see §5.

## 3. What one request costs, in units

Every `/api/*` request is **one Worker request + one Durable Object request**, plus the
rows it reads and writes, plus the object's time. The rows are what the storage quota
counts, so they were measured — in workerd (Miniflare), running the bundle wrangler
builds, with the object reporting `rowsRead` / `rowsWritten` from each statement's
cursor (`pnpm measure:rows`, `scripts/measure-rows.mjs`; the same script runs against a
real deployment with `CLUB_URL` and `CLUB_SETUP_KEY`, recording round-trip times instead
of rows). Index entries count as rows written, which is why a claim writes 13.

Measured 2026-10-01, workerd compatibility date 2026-09-01:

### One club, request by request

| Step                      | Request                               | Status | Rows read | Rows written | Response bytes |
| ------------------------- | ------------------------------------- | -----: | --------: | -----------: | -------------: |
| health, unclaimed         | `GET /api/v1/health`                  |    200 |         1 |            0 |             35 |
| claim                     | `POST /api/v1/claim`                  |    201 |         5 |           13 |            254 |
| health, claimed           | `GET /api/v1/health`                  |    200 |         1 |            0 |             34 |
| read invite               | `GET /api/v1/invite`                  |    200 |         2 |            0 |            100 |
| join                      | `POST /api/v1/join`                   |    201 |         6 |            5 |            255 |
| club (2 members)          | `GET /api/v1/club`                    |    200 |         4 |            0 |            392 |
| create challenge + result | `POST /api/v1/challenges`             |    201 |        11 |            7 |            288 |
| list challenges (1)       | `GET /api/v1/challenges`              |    200 |         4 |            0 |            291 |
| one challenge             | `GET /api/v1/challenges/:id`          |    200 |         4 |            0 |            289 |
| submit result             | `POST /api/v1/challenges/:id/results` |    201 |         9 |            4 |            163 |
| results (2)               | `GET /api/v1/challenges/:id/results`  |    200 |        10 |            0 |            329 |
| records (1 challenge)     | `GET /api/v1/records`                 |    200 |         5 |            0 |            171 |
| hosting                   | `GET /api/v1/hosting`                 |    200 |         2 |            0 |             97 |
| 401 (bad token)           | `GET /api/v1/club`                    |    401 |         0 |            0 |             78 |
| 409 (bad invite)          | `POST /api/v1/join`                   |    409 |         1 |            0 |             77 |
| 409 (second result)       | `POST /api/v1/challenges/:id/results` |    409 |         7 |            0 |             86 |

### The same reads with 20 members, 10 challenges, 191 results

| Step                                 | Request                              | Status | Rows read | Rows written | Response bytes |
| ------------------------------------ | ------------------------------------ | -----: | --------: | -----------: | -------------: |
| club (20 members)                    | `GET /api/v1/club`                   |    200 |        22 |            0 |           2094 |
| list challenges (10)                 | `GET /api/v1/challenges`             |    200 |       240 |            0 |           2740 |
| results (20)                         | `GET /api/v1/challenges/:id/results` |    200 |        66 |            0 |           3273 |
| records (10 challenges, 191 results) | `GET /api/v1/records`                |    200 |       401 |            0 |            171 |

Seeding that club took 216 requests, 3,985 rows read, 909 rows written (236 requests in all, none failed).

Two reads grow with the club and are the first thing a Public deployment must bound
(plan PR C): **`GET /challenges`** counts every challenge's results on the way out
(≈ 24 rows per listed challenge here), and **`GET /records`** derives the records by
reading every completed result (≈ 2 rows per result; 401 for 191). For a club of friends this is
nothing; for one room with the world in it, it is the cost driver. Both are
implementation choices inside the contract (club.md §0「決めないこと」), fixable by
keeping counts and records as rows instead of recomputing them.

## 4. Where the free plan's ceilings fall (arithmetic, not a forecast)

These are counts, derived from §2 and §3. They say how much use fits in a day, not what
anything costs — on the free plan, nothing does.

- **Requests.** Both quotas are 100,000 a day, and every API request spends one of
  each, so the deployment answers at most **100,000 API requests a day** and then
  returns errors until midnight UTC. Static assets do not count.
- **Rows written** (100,000 a day) is the binding write limit: with 5 per join,
  7 per challenge and 4 per result, a day holds on the order of **14,000 challenges or
  25,000 results** — far above the request ceiling's share of writes in practice.
- **Rows read** (5,000,000 a day) gives an average budget of **50 rows per request** at
  the request ceiling. The small-club reads are 1–11 rows; the two growing reads above
  can exceed the budget on their own once a club is large, which is why they are PR C's.
- **Duration** cannot be exceeded with one object (§2: 10,800 < 13,000 GB-s).
- **Storage**: a result is a few hundred bytes with its index entries; 5 GB is not a
  near-term limit.
- **Logs**: a Worker and an object invocation are two events per API request, so the
  200,000-a-day quota is reached at the request ceiling; past it logs are dropped, nothing
  else happens.

**The free plan fails closed.** Past any quota the deployment stops answering until the
next day and no charge arises — which is, mechanically, the behaviour
`PRODUCT_PRINCIPLES.md`「費用の上限」asks for ("無料枠を超えたら、機能を削るかデプロイを
畳む"). The trade is availability for cost certainty: an abusive day is an outage, not a
bill. Moving to the paid plan would invert that trade (no outage, list prices per million
above), and is a product-owner decision this document does not pre-empt.

## 5. Abuse: how far can it balloon, and what holds it

What a stranger can do without a token, and what it costs in units:

| Path                        | Limit in the object               | Rows per attempt          | Spends                      |
| --------------------------- | --------------------------------- | ------------------------- | --------------------------- |
| `GET /health`               | none (the contract's healthcheck) | 1 read                    | 1 Worker + 1 object request |
| `POST /join`, `POST /claim` | 10 per minute per client address  | 1 read on a bad token     | 1 Worker + 1 object request |
| anything with a bad token   | none needed                       | 0 (hash lookup is 1 read) | 1 Worker + 1 object request |

- **A flood from many addresses** cannot write anything or read much, but it can spend
  the day's 100,000 requests. On the free plan that is the outage of §4 and nothing
  more. On the paid plan it would be per-request cost — a reason to add an edge limit
  (the Rate Limiting binding, or a zone rate-limiting rule) **before** ever moving off
  the free plan, not a reason to add it now.
- **Members** are limited to 60 requests a minute each, 16 KB a body, 1 KB of `params`
  and of `facts`, and a club to 100 members (owners included). For a Public deployment
  the member cap is the lever that bounds everything else; what it should be is a
  PR C question.
- **The object's limiter is in memory.** An eviction (idle ~10 s, or a redeploy) forgets
  the current minute; the next minute is counted again. The contract's limits are
  "minimal" (club.md §5-1) and this is within that spirit.
- **Not verified, not relied on**: whether the zone's free plan includes a WAF rate
  limiting rule usable in front of the Worker. Worth checking before a Public launch.

## 6. Deploying and measuring — the product owner's part

The agent that wrote this never touched a Cloudflare account; these steps need one.

1. `pnpm install && pnpm build:worker` — bundles `src/worker/index.ts` exactly as
   `wrangler deploy` will (no account needed; CI runs this).
2. `pnpm exec wrangler login`, then `pnpm exec wrangler deploy`. The first deploy creates
   the `ClubObject` namespace with SQLite storage (immutable afterwards) and prints the
   `*.workers.dev` URL. A custom domain is optional and free.
3. `pnpm exec wrangler secret put CLUB_SETUP_KEY` with a long random string
   (for example `openssl rand -base64 32`). Optionally `CLUB_SECRET` the same way.
4. The round trip, by hand (README「Claim the club」has the shapes), in this order:
   `GET /api/v1/health` → `POST /api/v1/claim` → `GET /api/v1/invite` →
   `POST /api/v1/join` → `POST /api/v1/challenges` → `POST /api/v1/challenges/:id/results`
   → `GET /api/v1/records`. `pnpm exec wrangler tail` shows the object's errors live.
5. In the dashboard, the next day (metrics lag): **Workers & Pages → simple-games-club →
   Metrics** for Worker requests and CPU time; **Storage & Databases → Durable Objects**
   for object requests, duration (GB-s), rows read, rows written and stored bytes;
   **Billing** for the month's line items (which should read zero on the free plan).
6. Write what the dashboard says into §7, with the date and the number of requests sent.

## 7. Measured in production

**Not run.** No deploy has happened; this section is empty on purpose.

| Date | Requests sent | Worker requests (dashboard) | Object requests | Duration (GB-s) | Rows read | Rows written | Stored | Billed |
| ---- | ------------- | --------------------------- | --------------- | --------------- | --------- | ------------ | ------ | ------ |
|      |               |                             |                 |                 |           |              |        |        |

## 8. What this spike settles, and what it leaves open

Settled by the code and its tests:

- **A Durable Object satisfies club.md §5.** The 56 contract tests that run against the
  Node server run unchanged against the Worker in workerd and pass; the two files that
  do not are Node's static file server and Node's unit tests.
- **One object per deployment is enough for the contract**, and the name is the only
  thing to change if it ever is not.
- **Limits are enforced from the first request** with the same code and numbers as
  Node (`src/limits.ts`), inside the object.
- **The free plan's ceiling is a stop, not a bill** (§4).

Open, for PR C and for club.md §14 once §7 has numbers:

- The two growing reads (§3) need counts and records kept as rows before a Public room.
- Open joining for Public: how the first member token is issued (club.md §14-10 lists
  this; the Worker has every piece except the decision).
- Whether the daily puzzle is the Public leaderboard's axis.
- The Public member cap and display-name safeguards.
- The read-only, cached view for pixapps.ai (a Worker route with the Cache API; not
  started).
- Whether the Public deployment serves the web build at `/` at all, or only `/join`.
