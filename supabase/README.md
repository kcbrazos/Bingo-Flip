# Database

Postgres on Supabase. There is no backend process refereeing a match — row-level security and two
`SECURITY DEFINER` functions do the work a game server would normally do. See the main
[README](../README.md).

## Layout

```
supabase/
├── config.toml       Supabase CLI project config
├── migrations/       the source of truth, applied in filename order
└── functions/        edge functions (Deno)
```

**`migrations/` is authoritative.** Every change to the database is a file in there, named
`YYYYMMDDHHMMSS_description.sql`, applied in order and never edited once applied. If a migration
turns out to be wrong, the fix is another migration. Editing history means the database and this
directory stop agreeing, and there is no way to tell which one is right.

That rule starts from the first Bingo Flip migration. The two files here replace the fifty-five
Elden Battleship migrations that preceded them, which described a different game — this is a new
database rather than a migration path from an old one, and there is nothing in the wild to migrate.

## The migrations

| File | What's in it |
| --- | --- |
| `20260817000000_initial_schema` | rooms, players, team_ready, claims — and `claim_square()` / `unclaim_square()`, which are the whole game |
| `20260817010000_room_management` | the shared clock, rejoin codes, host takeover, captains, administrators, profiles |

The split is deliberate: the first file is the game, the second is everything about *running a room*
that would look the same whatever game was being played. Almost all of the second is carried over
from Elden Battleship unchanged in purpose.

### What to read first

`claim_square()` in the first file. Lockout, the flip and the win are all decided in there, under
one lock on the room row, and the reasoning for why each of them has to be settled together rather
than in a client is written above the code.

Two things in it are worth knowing before changing anything nearby:

- **`rooms.flip_cells` is the one part of the board that is stored.** Everything else is derived by
  each client from the room id, square set and seed. The flip squares are written down because
  `claim_square()` has to know whether the square just taken turns the board over, and re-deriving
  it would mean a second copy of the client's PRNG in plpgsql that must agree with it forever. It
  costs nothing in secrecy — flip squares are marked on the board by design — and the column is
  frozen once the room leaves the lobby.
- **`claims.flipped` means "this claim turned the board", not "this square is a flip square".** The
  distinction only bites under non-lockout, where a second team completing the same flip objective
  must not turn it again. Recording the event rather than the property is what lets the face stay a
  plain parity over the log.

## Applying them

With the [Supabase CLI](https://supabase.com/docs/guides/cli), linked to the project:

```bash
supabase db push
```

Or by hand: open the SQL Editor, paste one file, run it, then the next. **One file per run.** The
editor wraps a paste in a single transaction, so a failure anywhere rolls back everything in it,
including the parts that worked.

Everything here is written to be idempotent (`create ... if not exists`, policies dropped before
being created), so re-running a file that half-worked is safe.

## Status

**Neither file has been applied to a live project yet.** They are written and reasoned about but
unrun, so expect the first application to turn something up.

Nothing in this directory creates an owner. `admins` is seeded by hand:

```sql
insert into admins (user_id, display_name, is_owner)
values ('<your auth.uid()>', '<your name>', true);
```

## Edge functions

`functions/twitch-login` is the only one left. Battleship's `auto-fire` and `balance-board` went
with the features they served — there is no fleet to balance a board against, and nothing to fire.

Deploy with `supabase functions deploy twitch-login`. It is optional: without it, Twitch sign-in
fails and everything else works, because the app runs on anonymous auth and a profile only ever adds
a name.
