import { avatarConfigError, randomAvatarConfig, type AvatarConfig } from '../shared/avatar';

/**
 * For migration 010_avatar_config_required.ts: the users whose stored avatar_config must be
 * replaced (null, or anything that is not a valid catalog config), each with a new random valid
 * config. Pure, so it can be unit-tested without a database.
 */
export function avatarBackfill(
  rows: { id: string; avatar_config: unknown }[],
  random: () => number = Math.random,
): { id: string; avatar_config: AvatarConfig }[] {
  return rows
    .filter((r) => avatarConfigError(r.avatar_config) !== null)
    .map((r) => ({ id: r.id, avatar_config: randomAvatarConfig(random) }));
}
