/** Avatar part selections; each value is a slug for an SVG layer asset. */
export interface AvatarConfig {
  head: string;
  skin: string;
  face: string;
  hair: string;
}

export interface UserProps {
  id: string;
  username: string;
  displayName: string;
  avatarConfig: AvatarConfig | null;
  sessionId: string | null;
}

/** Identity shared by everyone in a room. No game actions. */
export class User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarConfig: AvatarConfig | null;
  readonly sessionId: string | null;

  constructor(props: UserProps) {
    this.id = props.id;
    this.username = props.username;
    this.displayName = props.displayName;
    this.avatarConfig = props.avatarConfig ? { ...props.avatarConfig } : null;
    this.sessionId = props.sessionId;
  }
}
