# Managed Club Houses — implementation preview

The product contract is
[simple-games `docs/architecture/managed-clubs.md`](https://github.com/yosuke1024/simple-games/blob/main/docs/architecture/managed-clubs.md),
with the 2026-10-23 amendment in `docs/PRODUCT_PRINCIPLES.md`. This document explains
how to operate this implementation. It is not a launch announcement. The matching
client changes are required to expose the managed flows.

## Available scope

| Plan  | Active members per club, including the owner | Clubs per owner | Provisionable              |
| ----- | -------------------------------------------- | --------------- | -------------------------- |
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

**No price, checkout or payment-provider integration is included.** Operators issue
time-limited entitlements through an authenticated API. The owner key cannot issue
or extend an entitlement. This is a foundation for the agreed subscription model;
charging, renewals and customer support must be connected before a paid launch.

## Configuration and isolation

Cloudflare uses the independent `wrangler.managed.toml`, not a change to the
existing public deployment in `wrangler.toml`.

| Setting                           | Purpose                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CLUB_MANAGED_ENABLED=1`          | Explicitly enables the managed API                                                                    |
| `CLUB_MANAGED_SECRET`             | Stable 32+ character secret for registry token hashes and derived holder credentials                  |
| `CLUB_MANAGED_ADMIN_KEY`          | Separate 32+ character operator credential; must differ from the secret                               |
| `CLUB_PUBLIC_ORIGIN`              | Public service origin for generated endpoints and invite links; configure for the intended deployment |
| `CLUB_CORS_ORIGINS`               | Allowed client origins; the managed example allows `https://pixapps.ai`                               |
| Client `VITE_MANAGED_CLUB_ORIGIN` | Opt-in build-time service origin; unset keeps managed entry points disabled                           |

Do not put either server secret in a client build. The client receives an individual
owner key, then separate member credentials scoped to each club. The directory
stores hashes rather than recoverable owner keys. The invite key that owners need
to share follows the existing club invite-storage contract.

The Worker routes managed requests through `ManagedDirectoryObject`, which checks
the registry and entitlement before opening `ManagedClubObject` for a known club.
Each club has its own SQLite database. Arbitrary club IDs do not allocate new clubs.
Discovery reads indexed registry metadata and does not fan out to every club.
Owner settings and membership changes synchronise that metadata. Visibility
changes hide the listing before the remote mutation; an uncertain acknowledgement
keeps it hidden until a successful retry, rather than showing stale public data.

Node uses the same controller and tenant API, with a registry and per-club SQLite
files under `CLUB_DATA_DIR/managed`. The same contract tests exercise Node and
Cloudflare's workerd runtime. The registry is a shared control point in this first
implementation; its throughput has not been established for future MAX usage.

## Operator entitlement API

All paths in this section begin with `/api/v1/managed` and require
`Authorization: Bearer <CLUB_MANAGED_ADMIN_KEY>`. Use the request body for values;
never place credentials in URLs or logs. `reference` is an opaque billing/customer
reference containing only letters, digits, `_` and `-` (1–128 characters), not an
email address or other customer profile.

| Method and path                       | Input                                                   | Result                                            |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `POST /admin/owners`                  | `{reference, plan: "basic", validUntil: ISO timestamp}` | `{owner, ownerToken}`; the key is returned once   |
| `GET /admin/owners?reference=...`     | Opaque reference                                        | `{owner}`; 404 if unknown; never returns a key    |
| `GET /admin/owners/:id`               | Owner ID                                                | `{owner}`; never returns a key                    |
| `PATCH /admin/owners/:id`             | `{validUntil: ISO timestamp}`                           | Sets the entitlement expiry; can renew or suspend |
| `POST /admin/owners/:id/rotate-token` | Empty object                                            | `{owner, ownerToken}` with a replacement key      |

`owner` includes `id`, `plan`, `validUntil` and current `status`. Provisioning the
same reference again returns `owner_exists` instead of creating another contract.
If the first response was lost, look up the reference and rotate the key. Hand the
key to the intended owner through an appropriate private channel. This repository
does not implement that delivery or a billing webhook.

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

## Validation and deployment boundary

`pnpm test` runs the shared API contract against both Node and Workers, including
quota races, admission, private discovery, cross-club credential isolation,
expiry, reconnect, credential rotation and deletion propagation. Store-level
crash and concurrency tests run on Node. `pnpm typecheck`, `pnpm lint` and
`pnpm format:check` cover the source. `pnpm build:worker` and `pnpm build:managed`
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
traffic. Choose pricing and billing rules from those measurements, implement the
checkout/renewal/cancellation lifecycle, and complete translation and device
review. Plus and MAX stay unavailable until their capacity and cost bounds have
been demonstrated. The code does not assert that any proposed price covers costs.
