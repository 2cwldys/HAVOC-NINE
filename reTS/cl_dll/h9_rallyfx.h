// H9 rally mode's visual effects on the client (h9_rallyfx.cpp): HL Rally's own set for a rally car, instead of the race effects of h9_racefx.cpp.
// The local car's skid marks, the dust and the tyre smoke of every car, the shadow of every car, the brake and reverse lamps, the headlights and the
// exhaust flame of the local car. The arithmetic is in h9_rallyfx_calc.h (no engine, tested by tests/racefx_test.cpp). h9_racefx.cpp calls this for the
// cars that h9_rallycar.h says are rally cars; the effects of a map that is not a rally map are not touched.
//
// Every sprite is OUR file under sprites/h9/rally/ (the same base names as HL Rally's own); a file that is not on disk is an effect that is not drawn,
// with no message.
#pragma once

struct model_s;

// A rally car of this frame, as h9_racefx.cpp noted it.
struct H9RallyFxCar
{
	int index;       // the entity's index
	bool local;      // the player's own car
	float origin[3]; // the entity's origin (on the floor: the car's box starts at 0)
	float yaw;
	float vel[3]; // its velocity: the entity's history for another car, the prediction's for the local one (when the sounds' note has it)
};

void H9RallyFx_Init();    // the cvars; and the user message H9RLight (the headlights)
void H9RallyFx_VidInit(); // a map change: every mark, state and sprite handle is dropped

// Once a frame from H9RaceFx_Draw (HUD_DrawTransparentTriangles), for the rally cars noted in it (`n` may be 0: the fades and the marks go on).
// `now` is the client's time, `dt` this frame's length in seconds.
void H9RallyFx_Frame(const H9RallyFxCar* cars, int n, float now, float dt);

// HL Rally's Flashlight message, in the form of ours: the headlights of entity `index` are on or off (HL Rally: rallyhud.cpp:232-258). The server tells
// it with the user message "H9RLight" (byte entity index, byte 0 or 1), which this file reads itself; this is also callable from anywhere.
void H9RallyFx_SetHeadlight(int index, bool on);

// The exhaust's place for the backfire flame (HL Rally: attachment 0 of the car's model, entity.attachment[0]): `attachment0` is where it was this
// frame. The flame is drawn only when it has been given one this frame, and only the local car's. Nothing calls this until the car's model has the
// attachment and the studio renderer fills it in (see the report).
void H9RallyFx_NoteExhaust(int index, const float attachment0[3]);

// The studio renderer, drawing a rally car (the player seen from outside): the chrome overlay model (models/h9/rc_rally_xs_chrome.mdl, HL Rally's
// rally_chrome), or null when the file is not on disk or cl_h9_rally_chrome is 0. To be drawn again after the car, added, on the same bones, with
// the ambient light at 24 (StudioModelRenderer.cpp:2386-2420 of HL Rally).
struct model_s* H9RallyFx_CarChrome();
