# S01 · Greet a caller by name

- **Repo:** fixture-node
- **Depends on:** none

## Objective
A caller can ask the API to greet them by name.

## What to do
1. Add `GET /greeting?name=<name>` to the `routes` map in `src/app.js`.

## Acceptance criteria
- [ ] `GET /greeting?name=Ada` returns 200 with body `{ "message": "Hello, Ada!" }`.
- [ ] A missing or empty `name` returns 400 with body `{ "error": "name is required" }`.
- [ ] A `name` longer than 50 characters returns 400 with body `{ "error": "name is too long" }`.
- [ ] Existing routes behave as before.

## Done when (commands)
```bash
npm run build
npm test
```

## Out of scope
- Localised greetings.
