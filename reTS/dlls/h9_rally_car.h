/***
*  h9_rally_car.h -- rally mode (H9): the car model for the clients (h9_rally_car.cpp).
***/
#pragma once

// Precaches models/h9/rc_rally_xs.mdl when the file is there, and the rally sounds (h9_rally_snd.cpp); every map, from ClientPrecache().
void H9RallyCarPrecache();
