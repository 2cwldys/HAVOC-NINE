// ---- H9 rally HUD: the engine's side -----------------------------------------------------------------------------------------------------
// While the local player is a rally car the race HUD is HL Rally's (h9_rallyhud_draw.h lays it out and is tested by tests/racehud_test.cpp).
// This file does what needs the engine: HL Rally's sprites (the two dials, the rev needle, the map's picture) and its three-dimensional
// countdown numerals. Every file is OURS and optional: none of them is loaded, precached or asked for while it is not on disk, and what has no
// file is not drawn (the numbers and the letters of the HUD are drawn in any case).
//
//   sprites/h9/rally/dials.spr      the dial in the views that show the car          (HL Rally's sprites/dials.spr)
//   sprites/h9/rally/dials2.spr     the dial in the interior view                     (sprites/dials2.spr)
//   sprites/h9/rally/hud_needle.spr the rev needle                                    (sprites/hud_needle.spr)
//   sprites/h9/rally/maps/<map>.spr the map's overview, one for each map              (sprites/maps/<map>.spr)
//   models/h9/rally/three.mdl, two.mdl, one.mdl, go.mdl   the start numerals          (models/three.mdl ...)
#pragma once

struct ref_params_s;

// From V_CalcRefdef, after the rally camera has been applied: the camera's origin and angles for the countdown's numerals (HL Rally puts
// them where the view looks).
void H9RallyHud_NoteView(const struct ref_params_s* pp);

// A new map or a video restart: the sprite handles are asked for again.
void H9RallyHud_Reset();

// The dial (by the view) and the map's picture, drawn before the HUD's numbers. Returns true when the map's picture is there.
bool H9RallyHud_DrawBack(bool third);

// The rev needle, over the numbers (HL Rally draws it last: tri.cpp). Only in the views that show the car.
void H9RallyHud_DrawNeedle(float rpm);

// The countdown: Start when a countdown begins (the client's time it began at), Think each frame while the local player is a car.
void H9RallyHud_CountdownStart(float clientStart);
void H9RallyHud_CountdownThink();
