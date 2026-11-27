import type { AvatarConfig } from '../shared/avatar';

/** Avatar part selections; each value is a slug from the shared catalog (shared/avatar.ts). */
export type { AvatarConfig };

export interface UserProps {
  id: string;
  username: string;
  displayName: string;
  avatarConfig: AvatarConfig;
  sessionId: string | null;
}

/** Identity shared by everyone in a room. No game actions. */
export class User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarConfig: AvatarConfig;
  readonly sessionId: string | null;

  constructor(props: UserProps) {
    this.id = props.id;
    this.username = props.username;
    this.displayName = props.displayName;
    this.avatarConfig = { ...props.avatarConfig };
    this.sessionId = props.sessionId;
  }
}
