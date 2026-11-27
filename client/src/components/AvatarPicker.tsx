import {
  AVATAR_KEYS,
  AVATAR_OPTIONS,
  randomAvatarConfig,
  type AvatarConfig,
  type AvatarKey,
} from '../../../server/src/shared/avatar';
import { AVATAR_SIZE, Avatar } from './Avatar';

const LABELS: Record<AvatarKey, string> = {
  head: 'Head shape',
  skin: 'Skin tone',
  face: 'Face',
  hair: 'Hair',
};

interface AvatarPickerProps {
  value: AvatarConfig;
  onChange(next: AvatarConfig): void;
  disabled?: boolean;
  /** The server's details.fields.avatarConfig, if it rejected the config. */
  error?: string;
}

/**
 * Live preview plus one row of option tiles per key (docs/architecture/avatar-system.md). Each
 * tile shows the whole avatar with that option, so skin tones and hairstyles are seen in context.
 */
export function AvatarPicker({ value, onChange, disabled, error }: AvatarPickerProps) {
  return (
    <div className="avatar-picker">
      <div className="avatar-picker-preview">
        <Avatar config={value} size={AVATAR_SIZE.picker} label="Avatar preview" />
        <button type="button" onClick={() => onChange(randomAvatarConfig())} disabled={disabled}>
          Surprise me
        </button>
      </div>
      {AVATAR_KEYS.map((key) => (
        <fieldset key={key} className="avatar-options" disabled={disabled}>
          <legend>{LABELS[key]}</legend>
          <div className="avatar-tiles">
            {AVATAR_OPTIONS[key].map((slug, i) => {
              const selected = value[key] === slug;
              return (
                <button
                  key={slug}
                  type="button"
                  className={selected ? 'avatar-tile selected' : 'avatar-tile'}
                  aria-pressed={selected}
                  aria-label={`${LABELS[key]} ${i + 1} of ${AVATAR_OPTIONS[key].length}`}
                  onClick={() => onChange({ ...value, [key]: slug })}
                >
                  <Avatar config={{ ...value, [key]: slug }} size={AVATAR_SIZE.tile} />
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
