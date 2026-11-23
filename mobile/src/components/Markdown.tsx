import { Lexer, type Token, type Tokens } from 'marked';
import { memo, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { leftoverBold } from '@leafbot/shared';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export interface Palette {
  text: string;
  /** Behind code. */
  code: string;
  /** Quote bars and rules. */
  line: string;
}

/** Markdown as native text: paragraphs, headings, lists, quotes, code and inline styles. */
export const Markdown = memo(function Markdown({
  text,
  palette,
  breaks = false,
}: {
  text: string;
  palette: Palette;
  /** Keeps each line break as typed, as a person's own message is written. */
  breaks?: boolean;
}) {
  const tokens = Lexer.lex(text, { gfm: true, breaks });
  return <View style={styles.blocks}>{blocks(tokens, palette)}</View>;
});

function blocks(tokens: Token[], p: Palette): ReactNode[] {
  return tokens.map((tok, i) => block(tok, p, i)).filter((n) => n !== null);
}

function block(tok: Token, p: Palette, key: number): ReactNode {
  const base: TextStyle = { color: p.text };
  switch (tok.type) {
    case 'space':
      return null;
    case 'paragraph':
    case 'text': {
      const t = tok as Tokens.Paragraph | Tokens.Text;
      return (
        <Text key={key} style={[styles.body, base]} selectable>
          {t.tokens ? inline(t.tokens, p) : t.text}
        </Text>
      );
    }
    case 'heading': {
      const t = tok as Tokens.Heading;
      return (
        <Text key={key} style={[styles.body, base, t.depth <= 2 ? styles.h1 : styles.h3]} selectable>
          {inline(t.tokens, p)}
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
              <View style={styles.itemBody}>{blocks(item.tokens, p)}</View>
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
            {t.text}
          </Text>
        </View>
      );
    }
    case 'blockquote': {
      const t = tok as Tokens.Blockquote;
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: p.line }]}>
          {blocks(t.tokens, p)}
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
          <Text style={styles.bold}>{line(t.header)}</Text>
          {t.rows.map((r) => `\n${line(r)}`).join('')}
        </Text>
      );
    }
    default:
      return 'text' in tok && typeof tok.text === 'string' && tok.text.trim() ? (
        <Text key={key} style={[styles.body, base]} selectable>
          {tok.text}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[], p: Palette): ReactNode[] {
  return tokens.map((tok, i) => {
    switch (tok.type) {
      case 'strong':
        return (
          <Text key={i} style={styles.bold}>
            {inline((tok as Tokens.Strong).tokens, p)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={styles.italic}>
            {inline((tok as Tokens.Em).tokens, p)}
          </Text>
        );
      case 'del':
        return (
          <Text key={i} style={styles.strike}>
            {inline((tok as Tokens.Del).tokens, p)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={i} style={[styles.mono, { backgroundColor: p.code }]}>
            {(tok as Tokens.Codespan).text}
          </Text>
        );
      case 'link': {
        const t = tok as Tokens.Link;
        return (
          <Text key={i} style={styles.link} onPress={() => void openLink(t.href)}>
            {inline(t.tokens, p)}
          </Text>
        );
      }
      case 'br':
        return '\n';
      case 'image':
        return (tok as Tokens.Image).text;
      case 'text': {
        const t = tok as Tokens.Text;
        // A single line break inside a paragraph is a space, as Markdown reads it; `breaks`
        // turns those into `br` tokens before they get here.
        if (t.tokens) return <Text key={i}>{inline(t.tokens, p)}</Text>;
        const plain = t.text.replace(/\n/g, ' ');
        // Bold the lexer left as asterisks, such as a suffix after a quoted word (`**"Yenile"**ye`).
        const pieces = leftoverBold(plain);
        if (!pieces) return plain;
        return (
          <Text key={i}>
            {pieces.map((piece, j) =>
              piece.bold ? (
                <Text key={j} style={styles.bold}>
                  {piece.text}
                </Text>
              ) : (
                piece.text
              ),
            )}
          </Text>
        );
      }
      default:
        return 'text' in tok && typeof tok.text === 'string' ? tok.text : '';
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
  h3: { fontWeight: '600' },
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
