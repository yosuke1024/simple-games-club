# simple-games-club

The server behind **Private Game Club**, the optional shared layer of
[Simple Games by PixApps](https://github.com/yosuke1024/simple-games).
One server is one club: a small group of people who know each other, playing
the same puzzles on their own devices and bringing only the results together.

Nothing about the games runs here. The app and the web version generate every
board on the device; this server holds a club's members, the challenges they
post (a game, a mode, a seed) and each member's result for a challenge — the
figures the result screen showed, and a nickname. There are no accounts,
passwords or e-mail addresses, no ranking across challenges, no notifications,
and nothing runs in the background.

PixApps operates none of these servers. Whoever creates a club hosts it, pays
for it and can delete it. The product decisions live in the simple-games
repository: `docs/PRODUCT_PRINCIPLES.md`「Shared」 draws the boundary,
`docs/architecture/club.md` is the contract this server implements.

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

| Variable                  | Default            | Meaning                                                                                              |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`             | Listening port                                                                                       |
| `CLUB_DATA_DIR`           | `./data` (`/data`) | The persistent directory: `club.sqlite` and `secret`                                                 |
| `CLUB_SETUP_KEY`          | —                  | Claims the club once. Re-set it to allow one more claim                                              |
| `CLUB_SECRET`             | generated          | Pepper for token hashes. Generated into `CLUB_DATA_DIR/secret` when absent                           |
| `CLUB_PUBLIC_ORIGIN`      | request host       | `https://…` used in invite links. Falls back to `RAILWAY_PUBLIC_DOMAIN`, then to the request headers |
| `CLUB_WEB_DIR`            | `./web`            | Where the Simple Games web build is served from                                                      |
| `CLUB_CORS_ORIGINS`       | —                  | Extra allowed origins, comma-separated (a local dev server). The app origins are always allowed      |
| `CLUB_HOSTING_PROVIDER`   | `railway` if there | A label for the owner's Hosting screen                                                               |
| `CLUB_HOSTING_MANAGE_URL` | derived on Railway | The provider dashboard, shown to owners only                                                         |
| `CLUB_TRUST_PROXY`        | `1`                | Read `X-Forwarded-*` (every PaaS sets them). `0` behind nothing                                      |
| `CLUB_LOG`                | `1`                | `0` silences the one-line request log                                                                |

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
pnpm test          # contract tests against a real server on a random port
pnpm dev           # build, then run on :8080 with ./data
pnpm lint && pnpm typecheck && pnpm format:check
```

Zero runtime dependencies. The database is Node's built-in `node:sqlite`
(Node ≥ 22.13), so the image has nothing native to compile and nothing to
keep patched; the `ExperimentalWarning` it prints is silenced in the start
script.

## License

Apache-2.0, like Simple Games itself. The "Simple Games" and "PixApps" names
and marks are not granted by the license — a fork that ships needs its own
name (see simple-games' `TRADEMARKS.md`).
