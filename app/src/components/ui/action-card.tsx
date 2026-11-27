// The look of this card is adapted from Uiverse.io by iconicchandu
// (https://uiverse.io/iconicchandu/slimy-pug-17, MIT License, Copyright (c) iconicchandu);
// its styles and the license notice are in action-card.css.
import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import './action-card.css';

/**
 * A card for a question that waits on the person, such as where someone new goes: dark green with
 * a light running round its edge, so it stands apart from the page. It is meant for few things at
 * a time; on everything it would stop catching the eye.
 */
function ActionCard({
  title,
  description,
  closeLabel,
  onClose,
  actionLabel,
  onAction,
  busy,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'section'>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** With `onClose`, a close button at the top right named by this label. */
  closeLabel?: string;
  onClose?: () => void;
  actionLabel: React.ReactNode;
  onAction: () => void;
  busy?: boolean;
}) {
  return (
    <section data-slot="action-card" className={cn('action-card', className)} {...props}>
      <div className="action-card__border" aria-hidden />
      <div className="action-card__head">
        <div className="min-w-0">
          <span className="action-card__title">{title}</span>
          {description && <p className="action-card__paragraph">{description}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            className="action-card__close"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <hr className="action-card__line" />
      {children}
      <button type="button" className="action-card__button" disabled={busy} onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}

function ActionCardList({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-slot="action-card-list" className={cn('action-card__list', className)} {...props} />;
}

/** A line of the list the person ticks: a ring that fills with a check once chosen. */
function ActionCardCheck({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <label className="action-card__item">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        <span className="action-card__check" aria-hidden>
          <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <path
              clipRule="evenodd"
              d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
              fillRule="evenodd"
            />
          </svg>
        </span>
        <span className="action-card__text min-w-0 truncate">{children}</span>
      </label>
    </li>
  );
}

export { ActionCard, ActionCardCheck, ActionCardList };
