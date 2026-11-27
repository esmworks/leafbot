# Leaf Bot

Notes for people and coding agents working on this repository.

## Rules

- Explain a decision by its reason. Commit messages, branch names, pull request titles and descriptions, code comments,
  test names and committed documents say why something is done, not which other project it resembles; they hold no
  paths into other repositories. Code adapted from elsewhere keeps the copyright and license notice its license
  requires.
- Commit messages, pull request titles and descriptions are written in English. Earlier commits in Turkish stay as
  they are.
- Text the person sees goes through the translation catalogs (`app/src/i18n`, `shared/src/i18n.ts`) in English and
  Turkish; `shared/src/hardcoded-text.test.ts` catches text written straight into the code. Other languages, such as
  German (`app/src/i18n/de.ts`), may lack newer keys; those show in English until translated.
- `shared/src/account.ts` and `shared/src/signal.ts` are the contract between Leaf Bot (app, server) and the
  account service and signalling relay, which run with the website and keep a copy of both files. Their build
  stops when the copy differs from this repository's, so a change here is made there in the same step.
- `PRD.md`, `TASKS.md` and anything under `docs/notes/` are local working notes and stay out of the repository (they
  are in `.gitignore`).

## Checks

Coding agents check only what they changed and never run the whole suite (`pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm format:check` over the whole repository): a run over everything is slow and loads the machine for a
change of a few lines. When a full run looks necessary, they say so and leave it to the person.

Tests of the changed code, by file path; a change with no test runs none:

```bash
pnpm vitest run shared/src/example.test.ts
```

Types of the package that changed:

```bash
pnpm --filter ./app typecheck
```

Lint and format of the changed files:

```bash
pnpm eslint app/src/example.ts
```

```bash
pnpm prettier --check app/src/example.ts
```

The `*.real.test.ts` files run against a real Claude account and are skipped unless `LEAFBOT_REAL_CLAUDE=1` is set.
