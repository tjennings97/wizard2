import { Card } from '../Card';
import { STANDARD_RULESET } from './standard';

describe('STANDARD_RULESET.determineTrump', () => {
  it('suited card flipped → that suit is trump', () => {
    expect(STANDARD_RULESET.determineTrump(Card.suited('clubs', 9))).toEqual({
      trumpSuit: 'clubs',
      trumpSource: 'flip',
      requiresDeclaration: false,
    });
  });

  it('Jester flipped → no trump', () => {
    expect(STANDARD_RULESET.determineTrump(Card.jester())).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: false,
    });
  });

  it('Wizard flipped → dealer must declare', () => {
    expect(STANDARD_RULESET.determineTrump(Card.wizard())).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: true,
    });
  });

  it('no card left to flip (all cards dealt) → no trump', () => {
    expect(STANDARD_RULESET.determineTrump(null)).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: false,
    });
  });
});
