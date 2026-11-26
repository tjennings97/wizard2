import { EventEmitter } from 'events';

/**
 * In-process notification seam for profile changes, like sessionEvents.ts: the REST route emits
 * after its transaction commits, the socket layer subscribes and refreshes what it shows other
 * users (lobby presence, open-room member lists). Auth never imports socket code.
 */
interface UserEventMap {
  /** The user's display name changed. */
  displayNameChanged: [userId: string, displayName: string];
}

class UserEvents extends EventEmitter<UserEventMap> {}

export const userEvents = new UserEvents();
