import type { Approval, EmailPreview } from '@leafbot/shared';
import { Ban, ChevronDown, Mail, Paperclip } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT, type T } from '@/i18n';
import { htmlPreviewDocument } from '@/lib/preview';
import { useMailSender } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** The tallest a mail's formatted body is drawn before it scrolls inside the card. */
const MAX_BODY_HEIGHT = 480;
/** A signature with a banner runs tall; it shows whole up to this. */
const MAX_SIGNATURE_HEIGHT = 900;

/**
 * A mail a bot asks to send through a connected app, shown as the mail itself: who gets it, the
 * subject and the body, with the button that sends it. Once answered it folds to one line that
 * opens the mail again.
 */
export function EmailApprovalCard({
  a,
  mail,
  service,
  connectionId,
  notes,
  offerAlways,
  busy,
  onDecide,
}: {
  a: Approval;
  mail: EmailPreview;
  /** The connection the mail goes from. */
  service?: string;
  /** Its id, to ask who it sends as. */
  connectionId?: string;
  /** Why the card asks: a rule, the review's reason, outside text. */
  notes?: ReactNode;
  /** "Always allow" is offered: no rule asks for every time, and no outside text started the run. */
  offerAlways: boolean;
  busy: boolean;
  onDecide(d: { decision: 'allow' | 'deny'; remember?: boolean }): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const draft = mail.kind === 'draft';
  if (a.status !== 'pending') {
    return (
      <div className="max-w-(--bubble-width) rounded-3xl border bg-card">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-center gap-3 px-5 py-3 text-start text-[15px]"
        >
          <Mail className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium">{t(`email.kind.${mail.kind}`)}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {[statusText(a, draft, t), mail.subject, mail.to.join(', ')].filter(Boolean).join(' · ')}
          </span>
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
        {open && (
          <div className="border-t px-5 pt-3 pb-4">
            <MailBody mail={mail} service={service} connectionId={connectionId} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="max-w-(--bubble-width) space-y-4 rounded-3xl border bg-card px-5 py-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Mail className="size-4" /> {t(`email.kind.${mail.kind}`)}
      </div>
      <MailBody mail={mail} service={service} connectionId={connectionId} />
      {notes && <div className="space-y-1 text-xs text-muted-foreground">{notes}</div>}
      <RawInput raw={mail.raw} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={busy}
          onClick={() => onDecide({ decision: 'deny' })}
        >
          {t('common.cancel')}
        </Button>
        <div className="flex">
          <Button
            size="sm"
            className="rounded-s-full rounded-e-none pe-3"
            disabled={busy}
            onClick={() => onDecide({ decision: 'allow' })}
          >
            {t(`email.action.${mail.kind}`)}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="rounded-s-none rounded-e-full border-l border-primary-foreground/20 px-2"
                disabled={busy}
                aria-label={t('email.more')}
              >
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 rounded-2xl">
              {offerAlways && (
                <DropdownMenuItem
                  title={t('approval.allowAlwaysHint')}
                  onSelect={() => onDecide({ decision: 'allow', remember: true })}
                >
                  {t('approval.allowAlways')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                title={t('approval.neverHint')}
                onSelect={() => onDecide({ decision: 'deny', remember: true })}
              >
                <Ban /> {t('approval.never')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** The one line an answered mail card shows. */
function statusText(a: Approval, draft: boolean, t: T): string {
  if (a.status === 'allowed')
    return t(a.remembered ? 'email.status.always' : `email.status.allowed.${draft ? 'draft' : 'send'}`);
  if (a.status === 'denied') return t(`email.status.denied.${draft ? 'draft' : 'send'}`);
  return t('email.status.expired');
}

function MailBody({
  mail,
  service,
  connectionId,
}: {
  mail: EmailPreview;
  service?: string;
  connectionId?: string;
}) {
  const t = useT();
  const { data: sender } = useMailSender(connectionId);
  const rows: [string, string][] = [];
  const from = sender?.address ?? service;
  if (from) rows.push([t('email.from'), from]);
  if (mail.to.length) rows.push([t('email.to'), mail.to.join(', ')]);
  else if (mail.kind === 'reply')
    rows.push([t('email.to'), t(mail.replyAll ? 'email.replyAllTo' : 'email.replyTo')]);
  if (mail.cc.length) rows.push([t('email.cc'), mail.cc.join(', ')]);
  if (mail.bcc.length) rows.push([t('email.bcc'), mail.bcc.join(', ')]);
  // A draft sent as it is has a subject of its own the card does not know: none is claimed.
  const subject =
    mail.subject ??
    ((mail.kind === 'send' || mail.kind === 'draft') && !mail.draftId ? t('email.noSubject') : null);
  return (
    <div className="space-y-3">
      {subject && <div className="text-lg font-medium break-words">{subject}</div>}
      <div className="divide-y border-b text-[15px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 py-2">
            <span className="shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 break-words">{value}</span>
          </div>
        ))}
      </div>
      {mail.draftId && !mail.text && !mail.html ? (
        <div className="text-sm text-muted-foreground">{t('email.savedDraft')}</div>
      ) : mail.html ? (
        <HtmlFrame html={mail.html} title={t('email.body')} maxHeight={MAX_BODY_HEIGHT} />
      ) : mail.text ? (
        <div className="scroll-thin max-h-[480px] overflow-auto text-[15px] break-words whitespace-pre-wrap">
          {mail.text}
        </div>
      ) : null}
      {/* The signature goes right under the text, where the mail carries it. */}
      {mail.signature &&
        (sender?.signature ? (
          <HtmlFrame
            html={sender.signature}
            title={t('email.signatureFrame')}
            maxHeight={MAX_SIGNATURE_HEIGHT}
          />
        ) : (
          <div className="text-sm text-muted-foreground">{t('email.signature')}</div>
        ))}
      {mail.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {mail.attachments.map((name, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-sm">
              <Paperclip className="size-3.5" /> {name || t('email.unnamedAttachment')}
            </span>
          ))}
        </div>
      )}
      {mail.kind === 'forward' && (
        <div className="text-sm text-muted-foreground">{t('email.forwardedBelow')}</div>
      )}
      {mail.inThread && <div className="text-sm text-muted-foreground">{t('email.inThread')}</div>}
    </div>
  );
}

/** Everything the tool is given, hidden until asked for: fields the card does not show are in it too. */
function RawInput({ raw }: { raw: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        {t(open ? 'email.hideRaw' : 'email.showRaw')}
      </button>
      {open && (
        <pre className="scroll-thin mt-2 max-h-64 overflow-auto rounded-xl bg-secondary px-3 py-2 text-xs break-words whitespace-pre-wrap">
          {raw}
        </pre>
      )}
    </div>
  );
}

/**
 * HTML in a frame that runs no script and loads nothing from outside (no tracking pictures, no
 * fonts): the bot may have written the body after reading someone else's text, and the
 * signature's pictures come inside it from the server. The frame shares the app's origin only so
 * its height can be read; with scripts off it cannot reach out.
 */
function HtmlFrame({ html, title, maxHeight }: { html: string; title: string; maxHeight: number }) {
  const [height, setHeight] = useState(120);
  return (
    <iframe
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={htmlPreviewDocument(
        `<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>${html}`,
      )}
      title={title}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        if (!doc) return;
        const full = doc.documentElement.scrollHeight;
        // What fits shows whole: a fraction of a pixel would otherwise draw a scroll bar.
        if (full <= maxHeight) doc.documentElement.style.overflow = 'hidden';
        setHeight(Math.min(maxHeight, full));
      }}
      style={{ height }}
      // Square corners: the card is white too, and a rounded one would clip the first letter.
      className="w-full bg-white"
    />
  );
}
