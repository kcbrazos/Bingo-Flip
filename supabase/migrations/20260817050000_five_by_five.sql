-- Flip is played on a 5x5. Not a default - the only size.
--
-- The schema inherited Battleship's 3-to-12 range along with its board renderer. A fleet needs room
-- to hide in; a flip board wants the opposite. Every square has to be readable at a glance on BOTH
-- faces, because the whole tactical question is what the unclaimed ones will become - and twenty-five
-- squares of objective text is already the most anybody holds in their head mid-race.
--
-- Written as a constraint rather than left to the lobby. The board-size control is gone from the UI,
-- but `rooms` is writable by any crew member, and a rule that lives only in a form is a rule that
-- holds until somebody sends a PATCH.
--
-- Everything downstream stays general: linesFor(), the dealer, claim_square() and the overlays are
-- all written against a board size and simply always read 5. Widening this again is one migration
-- and no application code.

-- Any room still sized otherwise becomes a 5x5. There should be none - nothing has been played - but
-- a constraint that fails on deploy because of one forgotten row is a miserable way to find out.
update rooms set board_size = 5 where board_size <> 5;

alter table rooms drop constraint if exists rooms_board_size_check;
alter table rooms add constraint rooms_board_size_check check (board_size = 5);

alter table rooms alter column board_size set default 5;

comment on column rooms.board_size is
  'Always 5. Kept as a column rather than inlined so the board maths stays general - see the note above the constraint.';

-- The archive keeps its own column unconstrained on purpose: it records what a match WAS played on,
-- and a record that cannot describe history is not a record. If the size ever changes, past matches
-- still read correctly.
