// Prints how much of the interface each language covers, and which keys it still shows in English.
// Run with `pnpm i18n:coverage`, or `pnpm i18n:coverage <locale>` to list that language's missing keys.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = join(root, 'app/src/i18n');

const { LOCALES, LOCALE_NAMES, INTL_LOCALE } = await import(join(root, 'shared/src/i18n.ts'));
const { en } = await import(join(i18nDir, 'en.ts'));

const files = new Set(
  readdirSync(i18nDir)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
    .map((name) => name.replace(/\.ts$/, '')),
);

const reference = Object.keys(en);
const rows = [];

for (const locale of LOCALES) {
  if (locale === 'en') continue;
  const file = join(i18nDir, `${locale}.ts`);
  if (!files.has(locale)) {
    rows.push({ locale, keys: 0, plural: 'missing file', missing: reference });
    continue;
  }
  const catalog = (await import(file))[locale] ?? {};
  const missing = reference.filter((key) => !(key in catalog));
  const rules = new Intl.PluralRules(INTL_LOCALE[locale]);
  const categories = new Set();
  for (let count = 0; count <= 110; count++) categories.add(rules.select(count));
  const plural = Object.entries(catalog)
    .filter(([, message]) => typeof message === 'object')
    .flatMap(([key, message]) => [...categories].filter((c) => !(c in message)).map((c) => `${key}:${c}`));
  rows.push({
    locale,
    keys: Object.keys(catalog).length,
    plural: plural.length ? plural.join(' ') : 'ok',
    missing,
  });
}

const widest = Math.max(...rows.map((row) => LOCALE_NAMES[row.locale].length));
console.log(`${reference.length} keys in English\n`);
for (const row of rows) {
  const percent = ((row.keys / reference.length) * 100).toFixed(1).padStart(5);
  console.log(
    `${row.locale.padEnd(3)} ${LOCALE_NAMES[row.locale].padEnd(widest)}  ${String(row.keys).padStart(5)} keys  ${percent}%  plural ${row.plural}`,
  );
}

const wanted = process.argv[2];
if (wanted) {
  const row = rows.find((r) => r.locale === wanted);
  if (!row) {
    console.error(`\nUnknown language: ${wanted}. One of: ${LOCALES.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nMissing in ${wanted}:\n${row.missing.join('\n')}`);
}
