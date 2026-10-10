-- 0012: live transcription connects through the server, once per live session.
--
-- Until now the browser got a short-lived OpenAI key from the start route and opened the realtime
-- transcription itself, and until that key expired it could open more sessions than the recorder's
-- one, on our bill (#34). Now the browser sends its WebRTC offer to /portal/checkin/live/connect;
-- the server claims the session's one connection here, opens the OpenAI session itself and answers
-- with OpenAI's reply, so no key ever reaches the browser. The audio still goes straight from the
-- browser to OpenAI.
--
--   * live_checkin_sessions.connected_at: when its one transcription connection was opened.
--   * connect_live_checkin_session: claims that connection, for the server only (as 0011's functions).

alter table live_checkin_sessions add column connected_at timestamptz;

-- True if the member's session is open, not yet expired and not yet connected, marking it connected;
-- false otherwise (not theirs, ended, expired, or connected already), so a second offer for the same
-- session never opens a second transcription session. One update, so two offers at once can't both
-- win.
create function connect_live_checkin_session(p_session_id uuid, p_member_id uuid)
  returns boolean
  language plpgsql set search_path = '' as $$
begin
  update public.live_checkin_sessions s
    set connected_at = now()
    where s.id = p_session_id and s.member_id = p_member_id
      and s.ended_at is null and s.connected_at is null and s.expires_at > now();
  return found;
end $$;

revoke execute on function connect_live_checkin_session(uuid, uuid) from public, anon, authenticated;
grant execute on function connect_live_checkin_session(uuid, uuid) to service_role;
