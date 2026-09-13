-- The channel login behind a linked Twitch account - what an embedded player is actually pointed
-- at, as opposed to twitch_id (the durable identity) or display_name (which can hold spaces and
-- capitalisation the embed API doesn't accept as a channel argument).
--
-- Already resolved by the twitch-login edge function on every sign-in (see its TwitchMetadata
-- object) and written to auth user_metadata there, but never carried into this table - there was
-- nothing here that needed it before the caster's player-stream monitor did. No backfill: an
-- existing session picks it up automatically on its next Twitch sign-in, the same way twitch_id
-- and display_name already do.
alter table profiles add column if not exists twitch_login text;
