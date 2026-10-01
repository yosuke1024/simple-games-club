# simple-games-club

The server behind **Club House**, the optional layer of
[Simple Games by PixApps](https://github.com/yosuke1024/simple-games).
One deployment is one club: people playing the same puzzles on their own
devices and bringing only the results together. It runs in two shapes from the
same source — a Node process with a SQLite file, or a Cloudflare Worker with a
Durable Object — and the same contract tests prove both.

Nothing about the games runs here. The app and the web version generate every
board on the device; this server holds a club's members, the challenges they
post (a game, a mode, a seed) and each member's result for a challenge — the
figures the result screen showed, and a nickname. There are no accounts,
passwords or e-mail addresses, no notifications, and nothing runs in the
background. Results are compared only within one challenge — the same board,
the same mode — and nothing accumulates across challenges.

Whoever creates a club hosts it, pays for it and can delete it. The product
decisions live in the simple-games repository: `docs/PRODUCT_PRINCIPLES.md`
「Club House」 draws the boundary, `docs/architecture/club.md` is the contract
this server implements.

**Status: pre-release.** The client side (`src/club/` in simple-games) is not
shipped yet. This server exists so it can be built against something real.

## Deploy

### Railway

A one-click template is planned. Until then, from this repository:

1. Create a service from this repository. `railway.toml` selects the
   Dockerfile, the healthcheck (`/api/v1/health`) and keeps app sleeping off.
2. Add a **volume** mounted at `/data`. The SQLite file and the generated
   secret live there; without it every redeploy is a new, empty club.
3. Set **`CLUB_SETUP_KEY`** to a long random string. The Simple Games app
   generates one for you in the "Create my Club" flow; for now, any 32+
   random characters will do. This key claims the club exactly once (below).
4. Deploy. The service's public domain is picked up from
   `RAILWAY_PUBLIC_DOMAIN` and used in invite links; the dashboard link shown
   to owners is derived from the Railway project variables.

### Cloudflare Workers

The same server as a Worker and one SQLite-backed Durable Object, on the
Workers Free plan ([docs/cloudflare.md](docs/cloudflare.md) has the
architecture, the plan's limits from Cloudflare's own documentation, and the
measured cost drivers). From this repository, with a Cloudflare account:

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler deploy                      # creates the object namespace (SQLite, fixed)
pnpm exec wrangler secret put CLUB_SETUP_KEY   # claims the club once (below)
```

`wrangler.toml` carries the rest. The web build goes in `web/` and is served
as static assets, free of request charges; only the API and the entry pages
run the Worker. `CLUB_SECRET` is optional here too — without it the object
generates one into its own storage.

### Docker, anywhere

```sh
docker build -t simple-games-club .
docker run -d --name club \
  -p 8080:8080 \
  -v club-data:/data \
  -e CLUB_SETUP_KEY='replace-with-32-random-characters' \
  -e CLUB_PUBLIC_ORIGIN='https://club.example.com' \
  simple-games-club
```

Put it behind HTTPS. The app refuses `http://` endpoints other than localhost.

The `-v` is not optional: the image declares no `VOLUME` of its own (Railway
rejects the instruction), so without a mount the club lives inside the
container and disappears with it.

### Claim the club

The first owner exchanges the setup key for a member token. The app does this
on the "Create my Club" screen; by hand:

```sh
curl -sS -X POST https://club.example.com/api/v1/claim \
  -H 'Content-Type: application/json' \
  -d '{"setupKey":"…","nickname":"Yoh","clubName":"Suzuki Family"}'
```

The response carries `memberToken` — this device's credential from now on —
and the club. The invite link for everyone else is one call away:

```sh
curl -sS https://club.example.com/api/v1/invite -H 'Authorization: Bearer <memberToken>'
```

It looks like `https://club.example.com/join#invite=<token>`. Whoever opens it
in a browser lands on the web build served by this same server (once it is
installed — next section), picks a nickname, and plays.

### Lost every owner device?

Set a **new** `CLUB_SETUP_KEY` on the service and redeploy. The server accepts
one more claim with the new key, adding an owner to the existing club; the old
key stays spent. Being able to change the variable is what proves you own the
server.

## Environment

The same names on both deployments — environment variables for the Node
server, `[vars]` and secrets for the Worker. Rows marked _Node_ have no
meaning on Workers (there is no port, no directory, no proxy in front).

| Variable                  | Default               | Meaning                                                                                                                   |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`                | _Node._ Listening port                                                                                                    |
| `CLUB_DATA_DIR`           | `./data` (`/data`)    | _Node._ The persistent directory: `club.sqlite` and `secret`                                                              |
| `CLUB_SETUP_KEY`          | —                     | Claims the club once. Re-set it to allow one more claim. A secret on Workers                                              |
| `CLUB_SECRET`             | generated             | Pepper for token hashes. Generated into `CLUB_DATA_DIR/secret` (Node) or the object's storage (Workers) when absent       |
| `CLUB_PUBLIC_ORIGIN`      | request host          | `https://…` used in invite links. Falls back to `RAILWAY_PUBLIC_DOMAIN`, then to the request                              |
| `CLUB_WEB_DIR`            | `./web`               | _Node._ Where the Simple Games web build is served from (Workers: the `[assets]` directory)                               |
| `CLUB_CORS_ORIGINS`       | —                     | Extra allowed origins, comma-separated (a local dev server). The app origins are always allowed                           |
| `CLUB_HOSTING_PROVIDER`   | `railway` if there    | A label for the owner's Hosting screen (`cloudflare` in `wrangler.toml`)                                                  |
| `CLUB_HOSTING_MANAGE_URL` | derived on Railway    | The provider dashboard, shown to owners only                                                                              |
| `CLUB_TRUST_PROXY`        | `1` Node, `0` Workers | Read `X-Forwarded-*` instead of the connection (Node: every PaaS sets them; Workers: Cloudflare already names the client) |
| `CLUB_LIMITS`             | —                     | _Workers._ A JSON object overriding entries of `src/limits.ts` for one deployment                                         |
| `CLUB_LOG`                | `1`                   | _Node._ `0` silences the one-line request log                                                                             |

`CLUB_TEST_MODE` also exists — for the test harness only, never set on a
deployment (`test/units.test.ts` checks `wrangler.toml`).

## Web build

The server answers `/` and `/join` with the Simple Games web build when one is
present in `CLUB_WEB_DIR` (`index.html` plus `assets/`). It is a release
artifact of the simple-games repository — the `dist-web/` output of its
`web-build.yml` workflow — not something built here. Copy its contents into
`web/` before `docker build`, or mount a directory at runtime.

Without a build the server still works: `/` and `/join` show a one-line notice
and the API is fully usable. `/join/` (with a slash) redirects to `/join`,
because the build's relative asset paths would otherwise resolve one directory
too deep.

## API

`docs/architecture/club.md` §5 in simple-games is the contract; the tests
under `test/` send its example JSON verbatim. In one screen:

```text
GET    /api/v1/health                        no auth       { ok, api: 1, claimed }
POST   /api/v1/claim                         setup key     { setupKey, nickname, clubName? } → { club, member, memberToken }
POST   /api/v1/join                          invite token  { inviteToken, nickname }         → { club, member, memberToken }
GET    /api/v1/club                          member        { club, me, members[] }
PATCH  /api/v1/club                          owner         { name }
GET    /api/v1/challenges[?after=<id>]       member        Challenge[]  (newest first, 50)
POST   /api/v1/challenges                    member        challenge + the creator's result → Challenge
GET    /api/v1/challenges/:id                member        Challenge
DELETE /api/v1/challenges/:id                creator/owner 204
GET    /api/v1/challenges/:id/results        member        Result[]  (submission order, 200)
POST   /api/v1/challenges/:id/results        member        one per member → Result
GET    /api/v1/records                       member        club records, derived
GET    /api/v1/hosting                       member        { provider, manageUrl (owners), referralUrl, lastActivityAt }
PATCH  /api/v1/hosting                       owner         { referralUrl | null }
GET    /api/v1/invite                        owner         { token, url }
POST   /api/v1/invite                        owner         { role: 'member' } rotates · { role: 'owner' } one-use link, 24h
DELETE /api/v1/members/:id                   owner         204; never the last owner
```

Every response carries `X-Club-Api: 1`. Errors are
`{ "error": { "code", "message" } }`; the codes and statuses are §5-1's, plus
`internal_error` (500) for anything unexpected.

Points the implementation settles within the contract:

- List endpoints return JSON arrays.
- The member invite token is stored as issued, so the owner can read it back;
  every other token — member tokens, owner links, the setup key — is stored as
  a SHA-256 hash peppered with `CLUB_SECRET`.
- `params` and `facts` are opaque, except in `src/contracts/games.ts`, which
  knows the comparison axis and mode key of each supported game (club.md
  §6-1) to derive records. A game not listed there has challenges and results
  but no records until the server learns it.
- Limits: 5 owners and 100 members per club, 10 join/claim attempts per IP per
  minute, 60 requests per member per minute, 16KB per request, 1KB per
  `params` and per `facts`.

## What is stored, what is logged

Stored: the club name, members' nicknames and roles, token hashes, challenges
(game id, mode parameters, seed, board digest, title), results (outcome and
the figures the result screen showed), the owner's referral link if they set
one, and the time of the last write. Nothing about a device, an OS, a
location, or a game's progress.

Logged: one line per request — method, path, status, milliseconds. No bodies,
no tokens; the invite token travels in the URL fragment and never reaches the
server at all.

## Development

```sh
pnpm install
pnpm test          # the contract tests, twice: against the Node server and against the Worker in workerd
pnpm test:node     # one of the two
pnpm test:workers
pnpm dev           # build, then run the Node server on :8080 with ./data
pnpm dev:worker    # the Worker locally (wrangler dev)
pnpm build:worker  # bundle the Worker as a deploy would, without an account
pnpm measure:rows  # rows read / written per request in workerd (docs/cloudflare.md §3)
pnpm lint && pnpm typecheck && pnpm format:check
```

The tests start a real server per test and talk HTTP to it; `test/helpers.ts`
starts whichever deployment `CLUB_IMPL` names, and `vitest.config.ts` runs the
same files for both. "The same experience" on both deployments means the same
tests, not shared code (simple-games `docs/PRODUCT_PRINCIPLES.md`「Club House」)
— though most of the code is shared as well: `src/app.ts` and `src/worker/`
are the only files that know what carries a request.

The Node server has zero runtime dependencies. Its database is Node's
built-in `node:sqlite` (Node ≥ 22.13), so the image has nothing native to
compile and nothing to keep patched; the `ExperimentalWarning` it prints is
silenced in the start script. The Worker is bundled by wrangler from the same
sources and needs nothing at runtime either.

## License

Apache-2.0, like Simple Games itself. The "Simple Games" and "PixApps" names
and marks are not granted by the license — a fork that ships needs its own
name (see simple-games' `TRADEMARKS.md`).
