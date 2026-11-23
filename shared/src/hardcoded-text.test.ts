import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LOCALES } from './i18n';

/**
 * Every text a person reads comes from a language catalog. This scans the source of every
 * package for text written straight into the code: strings with Turkish letters, and words in
 * JSX (between tags or in attributes people see). Tests and the catalogs themselves are skipped.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGES = [
  'app/src',
  'server/src',
  'shared/src',
  'client/src',
  'desktop/src',
  'computer/src',
  'mobile/src',
];

/** Files that hold the catalogs, or text no person reads. Each needs its reason. */
const ALLOWED = new Map<string, string>([
  ['app/src/i18n/tr.ts', 'Turkish catalog'],
  ['app/src/i18n/en.ts', 'English catalog'],
  ['app/src/i18n/de.ts', 'German catalog'],
  ['app/src/i18n/ar.ts', 'Arabic catalog'],
  ['app/src/i18n/es.ts', 'Spanish catalog'],
  ['app/src/i18n/fr.ts', 'French catalog'],
  ['app/src/i18n/hi.ts', 'Hindi catalog'],
  ['app/src/i18n/id.ts', 'Indonesian catalog'],
  ['app/src/i18n/it.ts', 'Italian catalog'],
  ['app/src/i18n/pl.ts', 'Polish catalog'],
  ['app/src/i18n/pt.ts', 'Portuguese catalog'],
  ['app/src/i18n/ru.ts', 'Russian catalog'],
  ['app/src/i18n/uk.ts', 'Ukrainian catalog'],
  ['app/src/i18n/vi.ts', 'Vietnamese catalog'],
  ['app/src/i18n/zh.ts', 'Chinese catalog'],
  ['server/src/i18n.ts', 'server catalogs'],
  ['desktop/src/i18n.ts', 'desktop catalogs'],
  ['mobile/src/i18n/tr.ts', 'Turkish catalog of the phone app'],
  ['mobile/src/i18n/en.ts', 'English catalog of the phone app'],
  ['mobile/src/i18n/de.ts', 'German catalog of the phone app'],
  ['mobile/src/i18n/parts/sidebar.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/chat.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/message.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/panel.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/dialogs.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/settings.ts', 'part of the phone app catalogs'],
  ['mobile/src/i18n/parts/apps.ts', 'part of the phone app catalogs'],
  ['server/src/engine/fake.ts', 'test engine: its directives and replies are Turkish test input'],
  [
    'shared/src/actions.ts',
    'approval sentences are built per language with its own grammar (Turkish verb forms), which a keyed catalog cannot express',
  ],
]);

/** Single texts that are not translated, such as names. Each needs its reason. */
const ALLOWED_TEXT: { file: string; text: string; reason: string }[] = [
  { file: 'app/src/features/Login.tsx', text: 'Leaf Bot', reason: 'product name' },
  { file: 'app/src/features/Sidebar.tsx', text: 'Leaf Bot', reason: 'product name' },
  { file: 'mobile/src/app/login.tsx', text: 'Leaf Bot', reason: 'product name' },
  { file: 'mobile/src/app/bots.tsx', text: 'Leaf Bot', reason: 'product name' },
  { file: 'app/src/features/SettingsPage.tsx', text: 'Leaf Bot', reason: 'product name' },
  {
    file: 'app/src/features/SettingsPage.tsx',
    text: 'Copyright © 2026 esmworks (Erhan Erbaş)',
    reason: 'copyright notice, the same in every language',
  },
  { file: 'shared/src/tables.ts', text: 'hayır', reason: 'a word read from input, never shown' },
];

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;
/** Attributes whose value is shown or read out to people. */
const VISIBLE_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'aria-description', 'label']);
/** A JSX text worth flagging has at least two letters in a row (not "·", "/", "×" or "x"). */
const WORDS = /\p{L}{2,}/u;

function sources(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full);
    if (!/\.(ts|tsx)$/.test(e.name) || /\.(test|real\.test)\.tsx?$/.test(e.name) || e.name.endsWith('.d.ts'))
      return [];
    return [full];
  });
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

export function findHardcodedText(file: string, code: string): Omit<Finding, 'file'>[] {
  const sf = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Omit<Finding, 'file'>[] = [];
  const add = (node: ts.Node, text: string) =>
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim() });

  const visit = (node: ts.Node) => {
    // A value keyed by language (`{ tr: …, en: … }`) is a small catalog of its own.
    if (ts.isPropertyAssignment(node) && (LOCALES as readonly string[]).includes(node.name.getText(sf)))
      return;
    // Commands and keys are typed as they are, in any language.
    if (ts.isJsxElement(node) && ['code', 'kbd'].includes(node.openingElement.tagName.getText(sf))) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (TURKISH.test(node.text)) add(node, node.text);
    } else if (ts.isJsxText(node)) {
      if (WORDS.test(node.text)) add(node, node.text);
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      if (VISIBLE_ATTRS.has(name) && WORDS.test(node.initializer.text))
        add(node, `${name}="${node.initializer.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('sabit metin', () => {
  it('denetim yakalaması gerekenleri yakalar, gerisine dokunmaz', () => {
    const code = `
      const a = 'Kaydedildi';            // no Turkish letter: not caught by the string rule
      const b = 'Dosya yüklenemedi';     // caught
      const c = \`\${n} dosya seçildi\`;  // caught
      const d = 'application/json';
      // Yorumdaki Türkçe sayılmaz
      const e = <div title="Kapat" aria-label={t('x')}>Gönder · {t('y')} ×</div>;
      const f = <span className="text-sm">·</span>;
      const g = { tr: 'Çarşamba', en: 'Wednesday' };
      const h = <code>claude setup-token</code>;
    `;
    const found = findHardcodedText('x.tsx', code).map((f) => f.text);
    expect(found).toEqual(['Dosya yüklenemedi', 'dosya seçildi', 'title="Kapat"', 'Gönder ·']);
  });

  it('arayüzde, sunucuda ve masaüstünde kullanıcıya görünen metin kataloglardan gelir', () => {
    const findings: Finding[] = [];
    for (const pkg of PACKAGES) {
      for (const full of sources(join(ROOT, pkg))) {
        const file = relative(ROOT, full);
        if (ALLOWED.has(file)) continue;
        for (const f of findHardcodedText(file, readFileSync(full, 'utf8'))) {
          if (!ALLOWED_TEXT.some((a) => a.file === file && a.text === f.text)) findings.push({ file, ...f });
        }
      }
    }
    // Shown as `file:line text` so each one is easy to find.
    expect(findings.map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });
});
