# Wizard Card Game — Game Rules Reference

Oct 13, 2026 · @TJ

## Overview

Wizard is a trick-taking card game for 3 to 6 players (this implementation supports 3 to 10) in which players bid the exact number of tricks they will win each round. Players score points only when their bid is exactly correct; overbidding and underbidding both result in a penalty. The player with the highest cumulative score after all rounds wins.

Each game consists of multiple rounds. In round 1 each player receives 1 card; in round 2, 2 cards; and so on. The maximum number of rounds is determined by dividing the deck size (60 cards in the standard edition) by the number of players. Players may choose to play fewer rounds than the maximum. The game ends after the final round and the player with the highest score wins.

## The Deck

The standard Wizard deck contains 60 cards: a standard 52-card deck (2 through Ace across four suits — Hearts, Diamonds, Spades, and Clubs) plus 4 Wizards and 4 Jesters.

**Suited cards:** The four standard suits — Hearts, Diamonds, Spades, and Clubs — each containing cards ranked 2 through Ace (13 cards per suit, 52 total). Ace is the highest ranked suited card. These follow normal suit and rank rules during trick-taking play.

**Wizards:** 4 cards with no suit or rank. A Wizard always wins the trick it is played in, regardless of trump or lead suit. If multiple Wizards are played in a single trick, the first Wizard played wins.

**Jesters:** 4 cards with no suit or rank. A Jester never wins a trick. If only Jesters are played in a trick, the first Jester played wins and the trick winner leads the next trick. If a Jester is led, the next card that is not a Jester decides the suit obligation (see Trick-Taking Phase).

**Total:** 52 suited cards + 4 Wizards + 4 Jesters = 60 cards.

**Other editions:** This implementation is designed to support the Wizard Camelot Edition as a future deck option. It is also a 60-card deck, with different cards. See Camelot Edition (Future) at the end of this document.

## Setup

**Players:** 3 to 10. The preferred range is 3 to 8. Games of 9 or 10 are permitted but produce shorter maximum round counts and longer per-turn wait times.

**Maximum rounds:** Computed at game start as `floor(60 / playerCount)`. Examples:

| Players | Max Rounds |
| --- | --- |
| 3 | 20 |
| 4 | 15 |
| 5 | 12 |
| 6 | 10 |
| 7 | 8 |
| 8 | 7 |
| 9 | 6 |
| 10 | 6 |

**Chosen rounds:** The host selects the number of rounds to play before the game begins, up to the computed maximum. The round selector updates live as players join or leave the lobby. Fewer rounds than the maximum are permitted.

**Dealing:** The deck is shuffled before each round. In round N, each player receives N cards. The deal rotates clockwise each round — the player to the left of the round N dealer deals in round N+1. All cards not dealt remain face-down and unused for that round, except the top card of the remaining deck which is turned face-up to determine trump (see Trump Suit).

**Round progression:** After each round, scores are updated, the deal rotates, and the next round begins with a fresh shuffle. Round number, current dealer, and scores are visible to all players at all times.

## Trump Suit

After dealing, the top card of the remaining deck is flipped face-up to determine the trump suit for that round. The trump suit beats all non-trump suited cards regardless of rank.

**Suited card flipped:** The suit of the flipped card is trump for the round. All players can see the trump card.

**Jester flipped:** There is no trump suit for the round. All tricks are won by highest card of the suit led (Wizards still win).

**Wizard flipped:** The dealer may view their hand before declaring one of the four suits as trump. The declaration must be made before bidding begins. The dealer's choice is visible to all players. This declaration event is recorded for game history and bot training purposes.

**Final round exception:** There is no trump suit only when every card in the deck has been dealt — that is, when the maximum number of rounds is played and 60 is exactly divisible by the player count (e.g. 4 players × 15 rounds = 60 cards). In all other cases, including when fewer than the maximum rounds are chosen, at least one card remains to flip for trump in the final round.

**Trump visibility:** The trump suit (or absence of one) is displayed prominently to all players and spectators for the duration of the round.

## Bidding Phase

After trump is determined, players bid the number of tricks they expect to win that round. Bidding happens before any cards are played.

**Order:** Bidding begins with the player to the left of the dealer and proceeds clockwise. The dealer bids last.

**Valid bids:** Any integer from 0 to the number of cards in hand (which equals the round number). A bid of 0 means the player intends to win no tricks.

**Bid total rule (host-configurable):** The host selects one of two modes before the game begins:

- **Open bidding (default):** No restriction on the sum of all bids. The total may equal, exceed, or fall short of the available trick count.
- **Uneven bidding:** In every round except the first, the sum of all bids must differ from the number of available tricks by at least 1. Round 1 (one trick) is exempt: bids there are unrestricted, as under open bidding. A round re-dealt after a player drop keeps its round number, so a re-dealt round 1 is still exempt. The last player to bid (the dealer) is subject to this constraint and will be blocked from placing a bid that would make the total equal the trick count. All other players bid freely.

The selected mode is visible to all players in the room before and during the game.

**Bid visibility:** Once placed, each player's bid is visible to all players and spectators for the remainder of the round. The running bid total is displayed so players can see whether tricks are over- or under-subscribed before they bid.

**Bidding position recorded:** Each player's position in the bidding order (1st, 2nd, … last) is recorded per round for game history and bot training.

**Bid locked:** A bid cannot be changed after it is submitted.

## Trick-Taking Phase

After all players have bid, tricks are played one at a time until all cards in hand have been played. The number of tricks per round equals the round number.

**Leading a trick:** The player to the left of the dealer leads the first trick. The winner of each trick leads the next.

**Following suit:** Players must follow the suit of the led card if they are able. If they cannot follow suit, they may play any card including trump or a special card. A Wizard or Jester may be played at any time, even by a player who holds a card of the suit to follow.

**Exception — Jester led:** If a Jester is led, the first card played that is not a Jester decides. If it is a suited card, it sets the suit that subsequent players must follow (if they can). If it is a Wizard, there is no suit obligation for the rest of the trick, as if the Wizard had been led.

**Exception — Wizard led:** If the lead card is a Wizard, there is no suit obligation. Players may play any card.

**Wizard played mid-trick:** Once a lead suit is established (by a suited lead, or by the first suited card after a Jester lead), a Wizard played later does not change the suit obligation. The remaining players must still follow the lead suit if they can.

**Winning a trick:** The trick is won by the highest-ranked card according to this priority:

1. **First Wizard played** wins unconditionally, regardless of any other cards in the trick.
2. **Highest trump card** wins if no Wizard was played and at least one trump card was played.
3. **Highest card of the lead suit** wins if no Wizard and no trump card was played.
4. **Jester** never wins unless all cards played in the trick are Jesters, in which case the first Jester played wins.

**Trick winner leads next:** After each trick is resolved, the winner leads the next trick. The trick winner, winning card, and winning card type (Wizard / trump / suited / Jester) are recorded.

**Tricks won tracking:** Each player's tricks won count is updated live and visible to all players and spectators throughout the round, alongside their bid, so over/under status is always visible.

## Scoring

Scoring is applied at the end of each round after all tricks have been played.

**Exact bid:** The player wins 20 points plus 10 points for each trick won.

- Example: Bid 3, won 3 → 20 + (3 × 10) = 50 points.
- Example: Bid 0, won 0 → 20 + (0 × 10) = 20 points.

**Overbid (won more tricks than bid):** The player loses 10 points for each trick over their bid. No base points are awarded.

- Example: Bid 2, won 4 → −(2 × 10) = −20 points.

**Underbid (won fewer tricks than bid):** The player loses 10 points for each trick under their bid. No base points are awarded.

- Example: Bid 3, won 1 → −(2 × 10) = −20 points.

**Scores may go negative.** There is no floor on a player's cumulative score.

**Score visibility:** Running totals are displayed to all players at all times. A full round-by-round breakdown is accessible via a scoreboard popup during and after the game.

**Recorded for metrics:** Per-round bid, tricks won, and resulting score delta are all stored for player history and bot training.

## End of Game

The game ends after the final chosen round is completed and all scores for that round have been applied.

**Time limit:** A game may last at most 3 hours. Players are warned 15 minutes before the limit. If the limit is reached, the game is abandoned: it is recorded as incomplete with no winner, and everyone returns to the lobby.

**Winner:** The player with the highest cumulative score wins. In the case of a tie, all tied players are recorded as co-winners.

**Post-game flow:** After scoring is displayed, a 30-second visible countdown is shown to all players and spectators. When the countdown expires, all users are returned to the lobby automatically. Users may leave manually before the countdown ends.

**Game result storage:** The final scores, winner(s), round count, player count, and per-round scoring detail are stored in game history and associated with each player's account for metrics and play history.

**Room closure:** After all players have left or the countdown expires, the room is closed and no longer accessible from the lobby.

## Special Cases and Edge Cases

**All-Wizard hand:** If a player holds only Wizards, they will win every trick they play. The player may bid any legal value — there is no restriction or warning from the game engine. This is legal gameplay.

**All-Jester hand:** A player holding only Jesters cannot win any trick unless all other players also play only Jesters in each trick. A bid of 0 is the correct response, though any bid is legal.

**All tricks taken by one player:** Legal. No redistribution occurs.

**Bid of 0 wins a trick accidentally:** The player loses 10 points per accidental trick won. The engine tracks this as a standard underbid outcome — the player bid 0 and won N, scoring −(N × 10).

**Player drops mid-game:** When a player quits or is timed out during a game, the current round is voided. Cards are re-dealt to the remaining players for a new round with the same round number. Round count and maximum rounds are not recalculated — the game continues with the original round structure applied to fewer players.

**Two-player edge case:** If player dropout reduces the active player count to 2 during a game that started with 3 players, the remaining two players are presented with a choice to continue or end the game. If they choose to continue, the game proceeds normally with 2 players. If they end it, no winner is declared for that game and the session is recorded as incomplete.

**Customizable round count:** Players may choose fewer rounds than the maximum. Round selection is controlled by the host in the lobby. The selected round count is locked when the game starts and cannot be changed mid-game.

**Tie in final scoring:** All tied players are recorded as co-winners. No tiebreaker round is played.

**No trump in final round:** There is no trump suit only when every card in the deck has been dealt — that is, when the maximum number of rounds is played and 60 is exactly divisible by the player count. In all other cases at least one card remains to flip for trump in the final round. See Trump Suit for full details.

**Camelot Edition (future):** A second 60-card deck with four new special cards. The maximum round count formula, `floor(deckSize / playerCount)`, is unchanged. See Camelot Edition (Future) below.


## Camelot Edition (Future)

The engine is built to support the **Wizard Camelot Edition** as a future deck option. It is not available in this version. The summary below is taken from the publisher's rules page: [Wizard Camelot Edition](https://wizardcards.com/Wizard/WizardCamelotEdition.html). Where that page is unclear, the gaps are listed under Open questions and must be settled before the edition is built.

### Deck

60 cards, the same total as the standard deck:

- **48 suited cards:** the four standard suits ranked 3 through Ace (the four 2s are removed). Ace is high.
- **4 Wizards** and **4 Jesters**, as in the standard deck.
- **4 new special cards, one copy each:** Holy Grail, Excalibur, Merlin, Morgan le Fay.

Because the deck is still 60 cards, the maximum round count (`floor(60 / playerCount)`) and the no-trump-in-the-final-round rule are unchanged.

### New special cards

| Card | Behaviour in a trick |
| --- | --- |
| **Morgan le Fay** | The most powerful card. Wins the trick unless the Holy Grail is played from an even position. |
| **Excalibur** | Wins the trick unless Morgan le Fay is played, or the Holy Grail is played from an even position. |
| **Holy Grail** | Depends on its position in the trick. Played 2nd, 4th or 6th, it wins over every other card, including Morgan le Fay. Played 1st, 3rd or 5th, it is a null card and always loses. |
| **Merlin** | Played as either a Wizard or a Jester. The player declares which when playing it, and the rules for that card then apply. |

**Wizards** still beat trump and all suited cards, and the first Wizard played wins among Wizards (Merlin played as a Wizard counts). A Wizard loses to Morgan le Fay, to Excalibur, and to the Holy Grail played from an even position.

**Jesters** still lose unless only Jesters are played (Merlin played as a Jester counts); the first Jester then wins.

### Trump

- A suited card turned up sets trump, as in the standard game.
- A Jester turned up means no trump.
- **Any other special card turned up** (a Wizard, Holy Grail, Excalibur, Merlin or Morgan le Fay) lets the dealer choose one of the four suits as trump. The dealer may not choose no trump.
- If every card is dealt in the final round, there is no trump.

### Following suit and leading

- Players must follow the suit led if possible, or play a special card. A player who cannot follow suit may play any card.
- **Jester led:** the Jester is a null card, and the next card played sets the suit that later players must follow. This matches this implementation's standard rule (see Trick-Taking Phase).
- **Holy Grail led:** it is in an odd position, so it is null and always loses; the next card played counts as the lead card.
- **Wizard, Excalibur or Morgan le Fay led:** the remaining players may play any card.

### Bidding and scoring

Unchanged from the standard game: bidding runs clockwise from the player left of the dealer, and scoring is +20 plus 10 per trick for an exact bid, and −10 per trick over or under.

### Open questions

1. **Null tricks:** the page says null tricks "do not count towards the tricks won" but does not say which plays produce a null trick. This affects scoring, since the engine currently requires every trick in a round to be won by someone.
2. **Hand One:** the page begins a sentence saying no player wins or loses points in a situation involving Hand One, but the sentence is incomplete, and its own Hand One example scores normally.
3. **Suit obligation after a Wizard, Excalibur or Morgan le Fay lead:** "remaining players may play any card" suggests there is none, but the page does not say whether a later suited card sets a suit to follow.
4. **"Winner of the trick is always player 1 (Odd)":** the page states this without explanation. It presumably means the trick winner leads the next trick from position 1, which matters for where the Holy Grail can be played.
5. **Uneven bidding:** the page does not mention a bid total rule. Decide whether this implementation's uneven option applies to Camelot games.
6. **Ranking among special cards** beyond the exceptions above is not stated, for example two cards that each "always win" except in listed cases.

### What building it requires

The engine selects an edition by deck type (`standard` today; `camelot` once built). Each edition is a ruleset that defines the deck, trump from the flipped card, follow-suit legality, and trick resolution, so the standard rules are not modified. Adding Camelot needs:

- New card types for Holy Grail, Excalibur, Merlin and Morgan le Fay.
- A Camelot ruleset implementing the rules above.
- A way for the player to declare Merlin as a Wizard or a Jester when playing it, added to the play-card action and recorded with the play.
- New winning card types for the event log.
- A decision on null tricks, which may change how rounds are scored.
