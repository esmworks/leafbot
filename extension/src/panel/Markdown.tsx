import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PLUGINS = [remarkGfm];

/**
 * A bot's reply as the app shows it: headings, lists, tables, code. Raw HTML is never drawn, and
 * links that are not web or mail addresses are dropped (the library's own address check). Pictures
 * are left out: a page the bot read could have put one in its reply to learn who opens it.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
