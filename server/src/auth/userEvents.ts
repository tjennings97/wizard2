import { EventEmitter } from 'events';
import type { AvatarConfig } from '../shared/avatar';

/**
 * In-process notification seam for profile changes, like sessionEvents.ts: the REST route emits
 * after its transaction commits, the socket layer subscribes and refreshes what it shows other
 * users (lobby presence, open-room member lists). Auth never imports socket code.
 */
interface UserEventMap {
  /** The user's display name changed. */
  displayNameChanged: [userId: string, displayName: string];
  /**
   * The user's avatar changed. Unlike a rename this is not broadcast (avatar-system.md, "Changing
   * an Avatar"): the socket layer only updates what it will send in the next snapshot.
   */
  avatarChanged: [userId: string, avatarConfig: AvatarConfig];
}

class UserEvents extends EventEmitter<UserEventMap> {}

export const userEvents = new UserEvents();
