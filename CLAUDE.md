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
- `PRD.md` and `TASKS.md` are local working notes and stay out of the repository (they are in `.gitignore`).

## Checks

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm format:check
```

```bash
pnpm test
```

The `*.real.test.ts` files run against a real Claude account and are skipped unless `LEAFBOT_REAL_CLAUDE=1` is set.
