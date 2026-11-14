// H9: the race's visual effects on the client (h9_racefx.cpp): tyre marks, spray, a shadow, brake lights, falling snow or rain.
// The arithmetic is in h9_racefx_calc.h (no engine, tested by tests/racefx_test.cpp).
#pragma once

struct cl_entity_s;

void H9RaceFx_Init();    // the cvars: cl_h9_racefx (master), _marks, _spray, _shadow, _lights, and cl_h9_raceweather (0 none, 1 snow, 2 rain)
void H9RaceFx_VidInit(); // a map change: every mark, puff, flake and sprite handle is dropped
// From HUD_AddEntity, for every entity the engine adds this frame: notes a race car (a model under models/h9/rc_) for the draw pass.
void H9RaceFx_NoteEntity(struct cl_entity_s* ent, const char* modelname);
// From HUD_DrawTransparentTriangles, once a frame: updates and draws all of it.
void H9RaceFx_Draw();
