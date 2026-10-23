# Managed Club Houses — implementation preview

The product contract is
[simple-games `docs/architecture/managed-clubs.md`](https://github.com/yosuke1024/simple-games/blob/main/docs/architecture/managed-clubs.md),
with the 2026-10-23 amendment in `docs/PRODUCT_PRINCIPLES.md`. This document explains
how to operate this implementation. It is not a launch announcement. The matching
client changes are required to expose the managed flows.

## Available scope

| Plan  | Active members per club, including the owner | Clubs per owner | Provisionable              |
| ----- | -------------------------------------------- | --------------- | -------------------------- |
| Trial | 5                                            | 1               | Yes; free self-service     |
| Basic | 50                                           | 3               | Yes                        |
| Plus  | 100                                          | 5               | No; future definition only |
| MAX   | Unlimited                                    | 100             | No; future definition only |

Members join without buying a plan. The owner controls discovery, admission
approval and enabled games. Public discovery returns club metadata, not member
records or albums. A private club needs an invite, and approval can independently
be required in either mode. New managed clubs start private.

Owner record summaries use one currently retained best record per active member;
they are not a full activity history, total-play counter or retention metric.
Daily comparisons require the same board identity. Owners can create at most
24 albums, each referencing at most 50 selected records. Removing a source record
or its member removes that source from subsequent album reads; the album does not
retain a separate copy of the score.

Trial is free with no automatic time limit. Trial owners can upgrade to Basic
without replacing their clubs, member identities, credentials or records.

Owners with **at least 50 current active memberships across their ready clubs**
receive ad removal on the owner devices where their access key is connected, while
their hosting entitlement is active. Each club's holder counts; pending, revoked
and provisioning memberships do not. These are club memberships, not deduplicated
people. The client owner screen shows the current count and benefit status. This
does not grant every member ad removal or create a permanent store purchase.

**No Basic price, checkout or payment-provider integration is included.** Operators
issue or upgrade to time-limited Basic entitlements through an authenticated API.
The owner key cannot extend paid capacity or duration. This is a foundation for the agreed subscription model;
charging, renewals and customer support must be connected before a paid launch.

## Configuration and isolation

Cloudflare serves managed hosting from the existing deployment in `wrangler.toml`, on the
Public Club House's origin `https://club.pixapps.ai` (decision 2026-10-24: one Club House
service, not two addresses). Managed requests are `/api/v1/managed/*` and `/clubs/*`; the
Public club keeps `/api/*` and its own Durable Object. The managed classes are added as
migration `v2`; `v1` is never edited. `wrangler.staging.toml` is the same Worker on its
workers.dev address with its own objects and secrets, for walking a release through before
club.pixapps.ai changes.

Before deploying `wrangler.toml` with managed hosting, put both managed secrets on the
`simple-games-club` Worker. Without them the managed routes answer 500; the Public club
is unaffected.

| Setting                        | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `CLUB_MANAGED_ENABLED=1`       | Explicitly enables the managed API                                                        |
| `CLUB_MANAGED_SECRET`          | Stable 32+ character secret for registry token hashes and derived holder credentials      |
| `CLUB_MANAGED_ADMIN_KEY`       | Separate 32+ character operator credential; must differ from the secret                   |
| `CLUB_PUBLIC_ORIGIN`           | Public service origin for generated endpoints and invite links: `https://club.pixapps.ai` |
| `CLUB_CORS_ORIGINS`            | Allowed client origins; the managed example allows `https://pixapps.ai`                   |
| Client `MANAGED_CLUBS_ENABLED` | Code constant in simple-games `ui/clubFeatures.ts`; the origin is the Public Club House's |

Do not put either server secret in a client build. The client generates its own
Trial owner key, or receives an operator-issued key, then obtains separate member credentials scoped to each club. The directory
stores hashes rather than recoverable owner keys. The invite key that owners need
to share follows the existing club invite-storage contract.

The Worker routes managed requests through `ManagedDirectoryObject`, which checks
the registry and entitlement before opening `ManagedClubObject` for a known club.
Each club has its own SQLite database. Arbitrary club IDs do not allocate new clubs.
Discovery reads indexed registry metadata and does not fan out to every club.
Owner settings and membership changes synchronise that metadata. Visibility
changes hide the listing before the remote mutation; an uncertain acknowledgement
keeps it hidden until a successful retry, rather than showing stale public data.
Explicit owner reads refresh the bounded set of ready clubs before returning the
benefit count: at most one tenant read for Trial and three for Basic. They share
the membership-mutation locks. A failed refresh returns an error instead of a new
trusted stale count; ordinary gameplay requests do not add this fan-out.

Node uses the same controller and tenant API, with a registry and per-club SQLite
files under `CLUB_DATA_DIR/managed`. The same contract tests exercise Node and
Cloudflare's workerd runtime. The registry is a shared control point in this first
implementation; its throughput has not been established for future MAX usage.

## Free Trial bootstrap

`POST /api/v1/managed/trial` accepts an empty JSON object and
`Authorization: Bearer <new owner key>`. Generate 32 cryptographically random bytes
on the client and encode them as **64 lowercase hexadecimal characters**. Persist
the key with `pendingTrial: true` before the request; after a validated response,
clear that flag and save the returned owner benefit. The endpoint stores only the
hash and never echoes the key. Keys must not appear in URLs or logs.

The endpoint returns **201** for a new owner and **200** when the same key is
retried, both using the same `OwnerSpace` as `GET /owner`. This makes a lost reply
recoverable without creating an inaccessible owner or spending another club slot.
A rotated bootstrap key remains revoked: retrying it returns 401 instead of
creating a new Trial. The client provides explicit show/copy controls for private
key recovery; normal game backups exclude the key and the benefit cache.

New registrations are limited to **10 per IP per minute**; idempotent retries use
the existing owner request limit. The in-memory limiter is not a unique-person
check and resets when its process/object is recreated. One owner key receives one
Trial, but a person can generate multiple keys. This preview does not add e-mail,
accounts, fingerprinting or an identity-verification service. Assess abuse and
resource budgets before opening unrestricted production registration.

## Operator entitlement API

All paths in this section begin with `/api/v1/managed` and require
`Authorization: Bearer <CLUB_MANAGED_ADMIN_KEY>`. Use the request body for values;
never place credentials in URLs or logs. `reference` is an opaque billing/customer
reference containing only letters, digits, `_` and `-` (1–128 characters), not an
email address or other customer profile.

| Method and path                       | Input                                           | Result                                          |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `POST /admin/owners`                  | `{reference, plan, validUntil}`; Trial or Basic | `{owner, ownerToken}`; the key is returned once |
| `GET /admin/owners?reference=...`     | Opaque reference                                | `{owner}`; 404 if unknown; never returns a key  |
| `GET /admin/owners/:id`               | Owner ID                                        | `{owner}`; never returns a key                  |
| `PATCH /admin/owners/:id`             | `{plan?, validUntil}`                           | Renews, suspends or upgrades Trial to Basic     |
| `POST /admin/owners/:id/rotate-token` | Empty object                                    | `{owner, ownerToken}` with a replacement key    |

`owner` includes `id`, `plan`, `validUntil` and current `status`. Provisioning the
same reference again returns `owner_exists` instead of creating another contract.
If the first response was lost, look up the reference and rotate the key. Hand the
key to the intended owner through an appropriate private channel. This repository
does not implement that delivery or a billing webhook.

Trial uses `validUntil: null` for no expiration; operators may set a timestamp to
suspend it. Basic requires an ISO timestamp. Upgrade an existing Trial with
`{plan: "basic", validUntil: <ISO timestamp>}`. Registry-supplied capacity changes
existing clubs from five to 50 members without rotating their credentials.
Capacity persists across tenant restarts and cannot be overridden by public
headers or rolled back by an older in-flight Trial request. Basic-to-Trial
downgrades return 409 `plan_unavailable`; Plus/MAX remain unavailable.

The registry migration replaces the former Basic-only constraints while preserving
owner IDs, hashes, references, credential versions, club rows and sequence order.
Interrupted rename/copy/drop stages are replayed safely on the next initialization.

Owners authenticate with their individual key at `GET /owner`, `POST /clubs` and
`POST /clubs/:id/connect`. Creating a club requires a `clientId` idempotency key;
retrying it uses the reserved slot instead of spending another club. Connect also
recovers a reserved club if provisioning was interrupted. Owner reconnect does not
add another member or discard existing member records.

### Lost or compromised owner key

Rotate with the operator API, then deliver the new owner key and reconnect each
club from the client. Rotation invalidates the old global owner key and every
contract-holder member key. Holder member IDs and records remain unchanged;
ordinary members and separately delegated owners keep their own credentials.

Credential versions only advance. Every managed club request carries the current
trusted credential version from the registry, so a partially failed rotation is
also applied before the next request is authorised. If the rotation response is
lost or returns an error, the operator can rotate again; do not assume the prior
key still works. Do not replace `CLUB_MANAGED_SECRET` as a substitute for this
procedure: it is also needed to authenticate existing stored hashes.

### Expiry and data access

Expiry hides clubs from the managed directory and blocks new clubs, joining,
invite issuance, approvals, challenges, result submissions and album creation.
Existing members can still read and remove their records; owners can still inspect
clubs, adjust settings, reject requests and remove members or albums. The contract
holder cannot be removed by a delegated owner. Renewing re-enables usage without
creating a new club. The client retains a bounded outbox while the subscription is
inactive rather than spending all retry attempts.

Expiry does not erase club data. Whole-contract deletion, retention after
cancellation and the customer-facing cancellation flow are not implemented in this
preview and must be decided and implemented before paid launch. Existing member
record deletion continues to work.

### Owner benefit response

`GET /owner` and `POST /trial` return the owner, dynamic plan limits, clubs and:

```ts
benefits: {
  adRemoval: {
    requiredMembers: 50;
    memberCount: number;
    active: boolean;
    validUntil: string | null;
  }
}
```

The count equals the sum of ready-club `memberCount` values in that response.
`active` requires both current active hosting and at least 50 memberships;
`validUntil` equals the owner's hosting expiration. Dropping below 50 or suspending
hosting disables the benefit when the client next checks the owner screen. Trial
cannot reach 50 within its capacity. The client keeps the last verified answer
until hosting expiry when offline, never writes it into the IAP purchase record,
and clears it on invalid credentials, key replacement/forgetting or local reset.
No background owner polling is added. Existing bought ad removal remains independent.

## Validation and deployment boundary

`pnpm test` runs the shared API contract against both Node and Workers, including
Trial bootstrap/idempotency, quota races, upgrades with preserved records and keys,
admission, private discovery, cross-club credential isolation, 49/50-member benefit
transitions, expiry, reconnect, credential rotation and deletion propagation. Store-level
crash and concurrency tests run on Node. `pnpm typecheck`, `pnpm lint` and
`pnpm format:check` cover the source. `pnpm build:worker` and `pnpm build:staging`
are dry runs and do not deploy. CI performs both Worker builds.

No production deployment, secret configuration, customer entitlement or charge is
created by this change. Keep managed UI opt-in until the matching server is ready.
The client includes new translated admission/consent text; its required human
review approvals and real-device/production-origin checks remain release gates.

## Cost and release follow-up

The existing `/api/v1/public` feed now uses `Cache-Control: no-store` and bypasses
the former five-minute Worker Cache API path, so newly private clubs are not
exposed through a stale feed. This materially changes the public feed's read cost.
The historical measurements in [cloudflare.md](cloudflare.md) do not establish
the cost of this version. Managed traffic adds registry work and a second object
hop; record summaries read retained records rather than precomputed usage totals.

Before enabling a paid service, measure realistic request rates, SQLite reads and
writes, object duration and stored data for Basic clubs, including public-feed
traffic, free Trial creation/retention and the bounded owner-benefit refresh reads.
Choose pricing and billing rules from those measurements, implement the
checkout/renewal/cancellation lifecycle, and complete translation and device
review. Plus and MAX stay unavailable until their capacity and cost bounds have
been demonstrated. The code does not assert that any proposed price covers costs.
