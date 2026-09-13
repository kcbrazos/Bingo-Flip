-- Board size, adjustable again.
--
-- 20260817050000_five_by_five.sql locked this to exactly 5 because a flip board wants every square
-- readable at a glance on both faces, and because a set needs 2*size*size distinct objectives to
-- deal one at all - both real tradeoffs, but ones a host can weigh for themselves. The request now
-- is to hand the choice back rather than have the app make it for them; the squareset-capacity half
-- of that tradeoff becomes a warning in the lobby instead (see MatchSettings and
-- lib/challenges.canCarryFlipBoard) rather than a rule enforced here.
--
-- 2 through 20, matching BOARD_SIZE_CHOICES in types/bingoFlip.ts - the two must agree, since the
-- application only ever offers this range and the database is what actually has to accept it.
-- Everything downstream already reads board_size rather than assuming 5 - see the note the previous
-- migration left on linesFor(), the dealer, claim_square() and the overlays - so widening the range
-- is exactly the one-migration, no-application-code change that migration predicted.

alter table rooms drop constraint if exists rooms_board_size_check;
alter table rooms add constraint rooms_board_size_check check (board_size between 2 and 20);

comment on column rooms.board_size is
  'The board is size x size. Adjustable in the lobby between 2 and 20 - see BOARD_SIZE_CHOICES.';

-- The default stays 5 - see DEFAULT_BOARD_SIZE - so a room nobody has touched this setting on plays
-- the same match it always did. Only the ceiling on what a host may choose instead is what moves.
