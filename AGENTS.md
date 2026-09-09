# simple-games-club — agent entry point

This is the server side of Simple Games' Private Game Club. Before changing
anything, read — in the [simple-games](https://github.com/yosuke1024/simple-games)
repository, which owns the product decisions:

1. `docs/PROJECT_CONTEXT.md` — the shared entry point.
2. `docs/PRODUCT_PRINCIPLES.md`「Shared」 — the boundary between Core and this layer.
3. `docs/architecture/club.md` — **the contract this server implements**. §5 is the
   API, §7 the invite URL, §8 the setup key / hosting model, §14 the decided points.

Rules that follow from those documents and are not negotiable here:

- The contract lives there, not here. A change to a request, response, code or
  limit is a change to `club.md` first; the tests under `test/` mirror its JSON.
- The server interprets `params` and `facts` in exactly one place
  (`src/contracts/games.ts`, for club records) and nowhere else.
- No accounts, no passwords, no e-mail, no OAuth. Tokens only, hashed at rest,
  except the member invite token the owner must read back.
- No polling, no push, no websockets, no background jobs, no analytics.
- Zero runtime dependencies. `node:sqlite` is the database.
