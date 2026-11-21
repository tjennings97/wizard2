import { CardData, Card } from './Card';
import { NotImplementedError } from './errors';
import { Player } from './Player';

/**
 * Placeholder for future AI players. Seats like any Player, but its actions
 * throw until a strategy is implemented.
 */
export class BotPlayer extends Player {
  override readonly isBot: boolean = true;

  override placeBid(_bid: number): void {
    throw new NotImplementedError('BotPlayer.placeBid is not implemented');
  }

  override playCard(_card: CardData): Card {
    throw new NotImplementedError('BotPlayer.playCard is not implemented');
  }
}
