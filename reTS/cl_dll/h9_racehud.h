// ---- H9 race HUD ----------------------------------------------------------------------------------------------------
// The race mode's HUD (dlls/race.cpp), drawn by the game in place of the server's text messages. It is a small one: while the
// player races, a piece in each corner of the screen (the lap and the place at the top left, the clocks at the top right, the
// lap's line with every racer at the bottom left, the speed and its gauge at the bottom right), each on the game's picture with
// a dark edge and no panel, and nothing over the road; the start lights and the countdown, and the notes (a checkpoint's split,
// a lap, wrong way, the finish), come and go small along the top's middle; the results are a table when the race is over.
//
// A game that draws it says so with the userinfo key _h9race (1 while cl_h9_racehud, saved, is not 0), and a server with the
// race mode then sends that player the H9R* user messages (dlls/race.h lists them) and none of its text. On a server without
// the race mode nothing comes and nothing is drawn; a server never hears a command from this.
//
// It is drawn with filled rectangles alone (h9_racehud_draw.h): no sprite, no font file. While the player races, the parts of
// TS's HUD that mean nothing in a car (the health panel, the aim names, the crosshair) are not drawn.
//
// A server is untrusted here: sizes and counts are checked against this client's own limits.
#pragma once

// From CHud::Init: hooks the messages, registers cl_h9_racehud and the userinfo key, and adds the HUD element.
void H9RaceHud_Init();

// True while the race HUD shows the player as a racer (a status came within the last second and a half).
bool H9RaceHud_Driving();

// Where a line of chat begins, in pixels from the left: 10 (the game's own), and to the right of the race HUD's map while that
// is drawn, since the chat's lines stand in the same corner.
int H9RaceHud_ChatLeft();
