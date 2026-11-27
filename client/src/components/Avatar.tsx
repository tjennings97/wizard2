import type { CSSProperties } from 'react';
import {
  DEFAULT_AVATAR,
  HAIR_COLOUR,
  SKIN_COLOURS,
  type AvatarConfig,
  type AvatarKey,
} from '../../../server/src/shared/avatar';

/** Sizes per surface (docs/architecture/avatar-system.md, "Surfaces and sizes"), in CSS px. */
export const AVATAR_SIZE = {
  picker: 128,
  tile: 64,
  profile: 128,
  room: 64,
  /** Lobby presence list and game seats: the player chip (docs/design/ui-foundation.md). */
  chip: 40,
  scoreboard: 32,
} as const;

type LayerKey = Exclude<AvatarKey, 'skin'>;

/** Layer files by slug, e.g. "head-01" → the file's SVG markup. */
function bySlug(files: Record<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1).replace(/\.svg$/, ''), svg]),
  );
}

// Bundled at build time from client/src/assets/avatar/. Every file shares viewBox 0 0 100 100;
// the head layer is filled with --avatar-skin and the hair layer with --avatar-hair.
const LAYERS: Readonly<Record<LayerKey, Readonly<Record<string, string>>>> = {
  head: bySlug(import.meta.glob<string>('../assets/avatar/head/*.svg', { query: '?raw', import: 'default', eager: true })),
  face: bySlug(import.meta.glob<string>('../assets/avatar/face/*.svg', { query: '?raw', import: 'default', eager: true })),
  hair: bySlug(import.meta.glob<string>('../assets/avatar/hair/*.svg', { query: '?raw', import: 'default', eager: true })),
};

/** Bottom to top. */
const LAYER_ORDER: readonly LayerKey[] = ['head', 'face', 'hair'];

/** The layer's markup, or the default layer's for a slug this build does not know. */
function layerSvg(key: LayerKey, slug: string | undefined): string {
  const files = LAYERS[key];
  return slug !== undefined && Object.hasOwn(files, slug) ? files[slug] : files[DEFAULT_AVATAR[key]];
}

function skinColour(slug: string | undefined): string {
  return slug !== undefined && Object.hasOwn(SKIN_COLOURS, slug) ? SKIN_COLOURS[slug] : SKIN_COLOURS[DEFAULT_AVATAR.skin];
}

interface AvatarProps {
  /** Unknown slugs (an older client than the server's catalog) fall back per layer. */
  config: AvatarConfig | null | undefined;
  /** CSS px; use AVATAR_SIZE for the surface. */
  size: number;
  /** Accessible name. Omit when a visible name sits next to the avatar. */
  label?: string;
}

/**
 * A player's avatar: the head, face and hair layers stacked in a circle.
 *
 * The layers are inlined so the CSS custom properties can colour them. The markup is only ever
 * one of the bundled layer files, looked up by slug; nothing from the server or another user is
 * inserted, so this is not an injection path.
 */
export function Avatar({ config, size, label }: AvatarProps) {
  const c = config ?? DEFAULT_AVATAR;
  const style = {
    width: size,
    height: size,
    '--avatar-skin': skinColour(c.skin),
    '--avatar-hair': HAIR_COLOUR,
  } as CSSProperties;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span className="avatar" style={style} {...a11y}>
      {LAYER_ORDER.map((key) => (
        <span key={key} className="avatar-layer" dangerouslySetInnerHTML={{ __html: layerSvg(key, c[key]) }} />
      ))}
    </span>
  );
}
