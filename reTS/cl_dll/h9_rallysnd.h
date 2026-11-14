// H9 rally mode's sounds on the client (h9_rallysnd.cpp): the engine of the local car and of the nearest other cars, played every frame from the client's own
// revs, the tyre squeal, the backfire, the wall, the race voices. The server plays only the horn and the landing (dlls/h9_rally_snd.cpp).
// The arithmetic is in h9_rallysnd_calc.h (no engine, tested by tests/rallysnd_test.cpp). Every sound file is optional: one that is not on disk
// (sound/h9/rally/...) is silence, with no message.
#pragma once

// Once a client frame (HUD_Frame): the loops of the local car and of the nearest cars, the squeal and the backfire.
void H9RallySnd_Frame();

// From the race HUD's messages (h9_racehud.cpp): H9RState (the race's state, the green light's time on the server's clock, that clock's now, the
// countdown's length in seconds) and H9RNote (RACE_NOTE_* kind, a, b).
void H9RallySnd_RaceState(int state, float greenAt, float serverNow, float countdown);
void H9RallySnd_RaceNote(int kind, int a, int b);

// The local car hit a wall: `crashAmount` is HL Rally's CL_CrashAmount (the velocity's part along the wall's normal, set only for a plane whose
// normal z is under 0.3, else 0), `pmTimeMs` pmove->time in milliseconds, `origin` pmove->origin. Called after the movement of each predicted command
// (HL Rally: cdll_int.cpp HUD_PlayerMove). Nothing calls it until the shared movement code reports the amount (see the report).
void H9RallySnd_Crash(float crashAmount, float pmTimeMs, const float origin[3]);

// The backfire flame's fade (1 as the pop starts, 0 when it is over or none): HL Rally draws additive quads for the 0.15 s of it; that is not here.
float H9RallySnd_BackfireFade();
