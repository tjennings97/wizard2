import { User } from './User';

/**
 * Read-only room member. Has no hand and no action methods; Game never
 * accepts a Spectator as a participant.
 */
export class Spectator extends User {
  readonly isSpectator = true as const;
}
