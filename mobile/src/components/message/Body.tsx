import { Lexer, type Token, type Tokens } from 'marked';
import type { ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { Markdown, type Palette } from '@/components/Markdown';
import { findOffsets } from './util';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const MARK: TextStyle = { backgroundColor: '#FDE047', color: '#121212' };

/**
 * A message as Markdown. Without a find query it is the shared renderer; with one that occurs in
 * the text, the same blocks are drawn here so the matches can be marked inside the text.
 */
export function Body({
  text,
  palette,
  breaks,
  find,
}: {
  text: string;
  palette: Palette;
  breaks?: boolean;
  find?: string;
}) {
  if (!find || findOffsets(text, find).length === 0) {
    return <Markdown text={text} palette={palette} breaks={breaks} />;
  }
  const tokens = Lexer.lex(text, { gfm: true, breaks: !!breaks });
  return <View style={styles.blocks}>{blocks(tokens, palette, find)}</View>;
}

/** Splits a piece of text at the matches; the matches get the mark style. */
function marked(text: string, find: string): ReactNode {
  const spans = findOffsets(text, find);
  if (!spans.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach(([start, end], i) => {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <Text key={i} style={MARK}>
        {text.slice(start, end)}
      </Text>,
    );
    at = end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function blocks(tokens: Token[], p: Palette, find: string): ReactNode[] {
  return tokens.map((tok, i) => block(tok, p, find, i)).filter((n) => n !== null);
}

function block(tok: Token, p: Palette, find: string, key: number): ReactNode {
  const base: TextStyle = { color: p.text };
  switch (tok.type) {
    case 'space':
      return null;
    case 'paragraph':
    case 'text': {
      const t = tok as Tokens.Paragraph | Tokens.Text;
      return (
        <Text key={key} style={[styles.body, base]} selectable>
          {t.tokens ? inline(t.tokens, p, find) : marked(t.text, find)}
        </Text>
      );
    }
    case 'heading': {
      const t = tok as Tokens.Heading;
      return (
        <Text key={key} style={[styles.body, base, t.depth <= 2 ? styles.h1 : styles.bold]} selectable>
          {inline(t.tokens, p, find)}
        </Text>
      );
    }
    case 'list': {
      const t = tok as Tokens.List;
      const start = typeof t.start === 'number' ? t.start : 1;
      // Wide enough for the list's longest number and its dot.
      const marker = t.ordered ? 10 + 9 * String(start + t.items.length - 1).length : 18;
      return (
        <View key={key} style={styles.list}>
          {t.items.map((item, i) => (
            <View key={i} style={{ paddingLeft: marker + 8 }}>
              <Text style={[styles.body, base, styles.marker, { width: marker }]} numberOfLines={1}>
                {item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${start + i}.` : '•'}
              </Text>
              <View style={styles.itemBody}>{blocks(item.tokens, p, find)}</View>
            </View>
          ))}
        </View>
      );
    }
    case 'code': {
      const t = tok as Tokens.Code;
      return (
        <View key={key} style={[styles.codeBlock, { backgroundColor: p.code }]}>
          <Text style={[styles.mono, base]} selectable>
            {marked(t.text, find)}
          </Text>
        </View>
      );
    }
    case 'blockquote': {
      const t = tok as Tokens.Blockquote;
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: p.line }]}>
          {blocks(t.tokens, p, find)}
        </View>
      );
    }
    case 'hr':
      return <View key={key} style={[styles.rule, { backgroundColor: p.line }]} />;
    case 'table': {
      // A narrow screen has no room for columns: each row becomes one line.
      const t = tok as Tokens.Table;
      const line = (cells: Tokens.TableCell[]) => cells.map((c) => c.text).join(' · ');
      return (
        <Text key={key} style={[styles.body, base]} selectable>
          <Text style={styles.bold}>{marked(line(t.header), find)}</Text>
          {marked(t.rows.map((r) => `\n${line(r)}`).join(''), find)}
        </Text>
      );
    }
    default:
      return 'text' in tok && typeof tok.text === 'string' && tok.text.trim() ? (
        <Text key={key} style={[styles.body, base]} selectable>
          {marked(tok.text, find)}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[], p: Palette, find: string): ReactNode[] {
  return tokens.map((tok, i) => {
    switch (tok.type) {
      case 'strong':
        return (
          <Text key={i} style={styles.bold}>
            {inline((tok as Tokens.Strong).tokens, p, find)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={styles.italic}>
            {inline((tok as Tokens.Em).tokens, p, find)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} style={styles.strike}>
            {inline((tok as Tokens.Del).tokens, p, find)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={i} style={[styles.mono, { backgroundColor: p.code }]}>
            {marked((tok as Tokens.Codespan).text, find)}
          </Text>
        );
      case 'link': {
        const t = tok as Tokens.Link;
        return (
          <Text key={i} style={styles.link} onPress={() => void openLink(t.href)}>
            {inline(t.tokens, p, find)}
          </Text>
        );
      }
      case 'br':
        return '\n';
      case 'image':
        return marked((tok as Tokens.Image).text, find);
      case 'text': {
        const t = tok as Tokens.Text;
        // A single line break inside a paragraph reads as a space.
        return t.tokens ? (
          <Text key={i}>{inline(t.tokens, p, find)}</Text>
        ) : (
          marked(t.text.replace(/\n/g, ' '), find)
        );
      }
      default:
        return 'text' in tok && typeof tok.text === 'string' ? marked(tok.text, find) : '';
    }
  });
}

/** Only web, mail, phone and text-message links open; anything else a bot wrote stays text. */
async function openLink(href: string) {
  if (!/^(https?|mailto|tel|sms):/i.test(href)) return;
  try {
    await Linking.openURL(href);
  } catch {
    // Nothing on the phone opens it.
  }
}

const styles = StyleSheet.create({
  blocks: { gap: 10 },
  body: { fontSize: 17, lineHeight: 26 },
  h1: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
  bold: { fontWeight: '600' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  mono: { fontFamily: MONO, fontSize: 15, lineHeight: 22 },
  list: { gap: 4 },
  // The marker hangs in the item's left padding, so the text is laid out at the item's own width
  // and a list inside a bubble that fits its text stays inside it.
  marker: { position: 'absolute', left: 0, textAlign: 'right' },
  itemBody: { gap: 6 },
  codeBlock: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  quote: { borderLeftWidth: 3, paddingLeft: 12, gap: 8 },
  rule: { height: StyleSheet.hairlineWidth },
});
