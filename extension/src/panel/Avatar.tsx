import { BRAND_COLOR, DEFAULT_AVATAR, type BotMaterial } from '@leafbot/shared';
import { objectDefinition } from '@leafbot/app/src/lib/object-avatars';
import { OBJECT_EYES } from '@leafbot/app/src/lib/object-motion';
import { mountAvatar, type AvatarMaterial } from 'open-bot-avatar/dom';
import { fluffy } from 'open-bot-avatar/materials/fluffy';
import { glass } from 'open-bot-avatar/materials/glass';
import { useEffect, useRef } from 'react';

/** The engine draws a finish from the material it is handed, not from its name. */
const MATERIALS: Record<BotMaterial, AvatarMaterial> = { flat: 'flat', fluffy, glass };

/** The engine takes a hex colour; a CSS variable such as the brand colour has no value in this page. */
function hexColor(color: string) {
  return color.trim().startsWith('var(') ? BRAND_COLOR : color;
}

/**
 * The bot's face as the app draws it in its list: an uploaded picture, or the object with eyes it
 * chose, as one still picture so a list of them costs no animation.
 */
export function Avatar({
  avatar,
  color,
  material = 'flat',
  size = 40,
}: {
  avatar: string;
  color: string;
  material?: BotMaterial;
  size?: number;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const isImage = avatar.startsWith('data:image/');
  const id = (avatar.startsWith('object:') ? avatar : DEFAULT_AVATAR).slice('object:'.length);

  useEffect(() => {
    const el = host.current;
    const definition = isImage ? undefined : objectDefinition(id, material);
    if (!el || !definition) return;
    const a = mountAvatar(el, { definition, eyeColor: OBJECT_EYES, label: '' });
    a.update({
      color: hexColor(color),
      eyeColor: OBJECT_EYES,
      material: MATERIALS[material],
      still: true,
      followPointer: false,
    });
    return () => a.destroy();
  }, [isImage, id, material, color]);

  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden>
      {isImage ? <img src={avatar} alt="" /> : <span ref={host} className="art" />}
    </span>
  );
}
