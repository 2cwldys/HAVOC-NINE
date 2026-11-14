/***
*  h9_rally_car.h -- rally mode (H9): the car model for the clients (h9_rally_car.cpp).
***/
#pragma once

// Precaches models/h9/rc_rally_xs.mdl when the file is there, and the rally sounds (h9_rally_snd.cpp); every map, from ClientPrecache().
void H9RallyCarPrecache();

// The interior's view model (models/h9/rally_interior.mdl, HL Rally's interior.mdl): its name when the file was there and was precached this map,
// else NULL. The player's viewmodel is set to it while he is in a car, and the clients draw the wheel, speedometer and rev counter on it
// (cl_dll/h9_rallycar.cpp).
const char* H9RallyInteriorModel();
