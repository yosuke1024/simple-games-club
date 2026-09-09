# Contract fixtures

The request bodies of `docs/architecture/club.md` §5-4 in the simple-games
repository, verbatim. The tests send them as they are (`join.request.json`
gets a real invite token in place of `…`) and assert the responses against
the shapes §5-2 names. When the contract changes, these files change with it
— never the other way round.
