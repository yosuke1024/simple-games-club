# simple-games-club — agent entry point

This is the server side of Simple Games' Club House. Before changing
anything, read — in the [simple-games](https://github.com/yosuke1024/simple-games)
repository, which owns the product decisions:

1. `docs/PROJECT_CONTEXT.md` — the shared entry point.
2. `docs/PRODUCT_PRINCIPLES.md`「Club House」 — the boundary between Core and this layer,
   and the cost ceiling a hosted deployment must stay under.
3. `docs/architecture/club.md` — **the contract this server implements**. §5 is the
   API, §7 the invite URL, §8 the setup key / hosting model, §14 the decided points.
4. `docs/architecture/managed-clubs.md` — the 2026-10-23 amendment for managed
   hosting, admission policy, owner records and albums. `docs/managed.md` here is
   its operator runbook, not a second product specification.

Rules that follow from those documents and are not negotiable here:

- The contract lives there, not here. A change to a request, response, code or
  limit is a change to `club.md` first; the tests under `test/` mirror its JSON.
- The server interprets `params` and `facts` in exactly one place
  (`src/contracts/games.ts`, for club records) and nowhere else.
- Ordinary members need no accounts, passwords, e-mail or OAuth. Managed owners
  have a self-service Trial or operator-provisioned Basic entitlement and an access key.
  The 50-member owner ad-removal benefit counts current memberships while hosting is active;
  it is not a permanent purchase or a count of unique people across clubs.
  Tokens are hashed at rest, except the member invite token the owner must read back.
- No polling, push, websockets, background jobs or gameplay telemetry. Owner
  summaries derive only from the bounded records members already chose to share;
  they must not imply a complete play history.
- Two deployments, one contract. The API lives in `src/api/` and `src/http/api.ts`
  and is carried by `src/app.ts` (Node, `node:sqlite`) and `src/worker/` (Cloudflare
  Workers, a Durable Object's SQLite). A behaviour change goes in the shared code; an
  adapter never grows a route, a check or a status code of its own. `pnpm test` runs
  the same contract tests against both, and both must pass.
- Zero runtime dependencies on Node. The Worker is bundled by wrangler from the same
  sources (`wrangler.toml`); its cost drivers are in `docs/cloudflare.md`.
