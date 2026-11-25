import { Card, Suit } from '../Card';
import { Deck } from '../Deck';
import { EngineError } from '../errors';
import { Game } from '../Game';
import { Player } from '../Player';
import { Round } from '../Round';
import { DECK_TYPES, Ruleset, getRuleset } from '.';
import { STANDARD_RULESET } from './standard';
import { Trick } from '../Trick';

describe('Ruleset registry', () => {
  it('lists the supported deck types', () => {
    expect(DECK_TYPES).toEqual(['standard']);
  });

  it('looks up a ruleset by deck type', () => {
    expect(getRuleset('standard')).toBe(STANDARD_RULESET);
    expect(STANDARD_RULESET).toMatchObject({ deckType: 'standard', deckSize: 60 });
  });

  it.each([
    ['a planned but unbuilt edition', 'camelot'],
    ['an unknown name', 'not-a-deck'],
    ['an empty string', ''],
  ])('rejects %s with an INVALID_CONFIG EngineError', (_label, deckType) => {
    expect(() => getRuleset(deckType)).toThrow(EngineError);
    expect(() => getRuleset(deckType)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

/**
 * A made-up edition, used to prove that Trick, Round, and Game take their
 * card behaviour from the ruleset rather than hard-coding standard rules.
 */
const LAST_CARD_WINS: Ruleset = {
  ...STANDARD_RULESET,
  // Every flip, even a suited card, asks the dealer to declare.
  determineTrump: (flipped) => ({
    trumpSuit: null,
    trumpSource: null,
    requiresDeclaration: flipped !== null,
  }),
  suitToFollow: () => null,
  isLegalPlay: (_plays, _hand, card) => !card.isJester,
  resolveTrick: (plays) => ({ winnerIndex: plays.length - 1, winningCardType: 'suited' }),
};

describe('Engine classes delegate to the ruleset', () => {
  it('Trick uses the ruleset for legality and the winner', () => {
    const t = new Trick(1, 'a', LAST_CARD_WINS);
    t.playCard('a', Card.wizard());
    t.playCard('b', Card.suited('hearts', 2));
    expect(t.isLegalPlay([Card.jester()], Card.jester())).toBe(false);
    expect(t.resolve('hearts')).toBe('b');
  });

  it('Round uses the ruleset for trump and passes it to its tricks', () => {
    const r = new Round({
      roundNumber: 1,
      seatOrder: ['a', 'b', 'c'],
      dealerId: 'a',
      bidRule: 'open',
      trumpCard: Card.suited('clubs', 5),
      ruleset: LAST_CARD_WINS,
    });
    expect(r.awaitingDeclaration).toBe(true);
    r.declareTrump('a', 'spades');
    for (const id of r.bidOrder) r.recordBid(id, 0);
    const trick = r.startTrick('b');
    trick.playCard('b', Card.wizard());
    trick.playCard('c', Card.suited('hearts', 2));
    expect(trick.resolve(r.trumpSuit as Suit)).toBe('c');
  });

  it('Game hands its ruleset to the deck factory', () => {
    const seen: string[] = [];
    const g = new Game({
      gameId: 'g',
      roomId: 'r',
      players: ['a', 'b', 'c'].map(
        (id) => new Player({ id, username: id, displayName: id, avatarConfig: null, sessionId: null }),
      ),
      config: { roundCount: 1 },
      deckFactory: (ruleset) => {
        seen.push(ruleset.deckType);
        return new Deck(ruleset.deckType).shuffle();
      },
    });
    g.startRound();
    expect(seen).toEqual(['standard']);
  });
});
