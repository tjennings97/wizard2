import type { AvatarConfig } from './types';

/**
 * Registration still requires an avatarConfig. Until the avatar picker exists
 * (remaining-work prompt 7, avatar-system.md), every new account gets this placeholder;
 * the picker on /profile will let players change it.
 */
export const PLACEHOLDER_AVATAR: AvatarConfig = {
  head: 'round',
  skin: 'medium',
  face: 'smile-01',
  hair: 'curly-short-brown',
};
