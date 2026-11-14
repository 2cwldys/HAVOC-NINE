/***
*  race_rally.h -- the race in rally mode, the part that needs no engine (H9). race.cpp calls it; race_test.cpp drives it.
*
*  In rally mode (race_rules key `vehicle "rally"`, or the cvar h9_rally 1..3) a racer is a living player who IS the car
*  (pm_shared/h9_rally.h), not a driver of an h9_car. This file holds what is plain arithmetic: which vehicle is in force,
*  the lowest free grid slot, a racer's skin, the two state bytes other clients draw marks and brake lights from, the
*  gauge's numbers, and the watch that puts a racer back when he is out of the world or under water.
***/
#pragma once

#define H9RALLY_MATHS_ONLY
#include "../pm_shared/h9_rally.h"

#include <string.h>

// The `vehicle` key: "rally" (any case) is rally mode; "car", nothing, or anything else is the h9_car.
static inline bool RaceVehicleKeyIsRally(const char* value)
{
	if (!value)
		return false;
	const char* word = "rally";
	for (int i = 0; i < 5; i++)
	{
		const char c = value[i] >= 'A' && value[i] <= 'Z' ? (char)(value[i] + 32) : value[i];
		if (c != word[i])
			return false;
	}
	return value[5] == 0;
}

// The car class a map's racers drive as (1..3), or 0 for the h9_car. The cvar h9_rally 1..3 forces rally in any race map
// and picks the class; with it 0 the map's key decides, and the class is 1.
static inline int RaceRallyClassFor(bool keyIsRally, int cvarValue)
{
	if (cvarValue >= 1)
		return cvarValue > H9R_NUM_CARS ? H9R_NUM_CARS : cvarValue;
	return keyIsRally ? 1 : 0;
}

// The lowest slot (1..count) that `used` (indexed by slot) leaves free; 0 when the grid is full.
static inline int RaceLowestFreeSlot(const bool* used, int count)
{
	for (int slot = 1; slot <= count; slot++)
		if (!used[slot])
			return slot;
	return 0;
}

// The car model has eight liveries.
static inline int RaceRallySkin(int slot)
{
	return slot < 1 ? 0 : (slot - 1) % 8;
}

// The surface byte (the low 3 bits of blending[1]; H9SURF_ in h9_car.cpp, Surface in cl_dll/h9_racefx_calc.h) for a
// rally surface: 0 tarmac, 1 gravel, 2 dirt, 3 grass, 4 water, 5 snow, 6 ice.
static inline int RaceSurfaceByte(int rallySurface, bool water)
{
	if (water)
		return 4;
	switch (rallySurface)
	{
	case H9RS_DIRT:
	case H9RS_PACKED:
	case H9RS_SAND: return 2;
	case H9RS_GRAVEL: return 1;
	case H9RS_GRASS: return 3;
	case H9RS_SNOW: return 5;
	case H9RS_ICE: return 6;
	default: return 0; // road, concrete, metal, neutral
	}
}

// What a racer's car is doing, from his velocity, his heading (the view yaw, degrees) and his keys.
struct RaceRallyDrive
{
	float speed = 0;     // along the nose, negative backwards (the gauge)
	float slip = 0;      // 0..1: the sine of the slip angle, none below 30 u/s
	int blending0 = 0;   // slip * 255, as h9_car writes it
	int blending1 = 0;   // surface | airborne 8 | braking 16 | handbrake 32, as h9_car writes it
};
static inline RaceRallyDrive RaceRallyDriveOf(float vx, float vy, float yawDegrees, bool airborne, bool back, bool hand,
											  int surfaceByte)
{
	RaceRallyDrive d;
	const float rad = yawDegrees * 0.017453292f;
	const float fx = cosf(rad), fy = sinf(rad);
	const float vf = vx * fx + vy * fy;
	const float vs = -vx * fy + vy * fx; // across the nose, positive to the left
	const float s = sqrtf(vx * vx + vy * vy);
	d.speed = vf;
	if (s > 30.0f)
		d.slip = H9RClamp(fabsf(vs) / s, 0.0f, 1.0f);
	d.blending0 = (int)(d.slip * 255.0f);
	// HL Rally's back key is a brake above reverse speed, the handbrake is the jump key
	const bool braking = back && vf > H9R_REVERSE_ENTER;
	d.blending1 = (surfaceByte & 7) | (airborne ? 8 : 0) | (braking ? 16 : 0) | (hand ? 32 : 0);
	return d;
}

// The gauge's end for a car class: the speed the engine's pull meets the drag at on a road (HL Rally's fastest ground).
static inline float RaceRallyTopSpeed(int cls)
{
	const H9RallyCar& car = H9RallyCarByClass(cls);
	return H9R_ACCELERATE * H9RallyWish(car) / (H9R_FRICTION - 0.10f);
}

// The watch that puts a racer back on the track: out of the world (below it, at once; inside rock, `voidTime`) or in deep
// water (`waterTime`). Update() answers true on the frame he is to be put back, and starts again.
struct RaceStrandWatch
{
	float water = 0, inRock = 0;
	bool Update(bool belowWorld, bool inSolid, bool deepWater, float dt, float waterTime = 3.0f, float rockTime = 1.5f)
	{
		water = deepWater ? water + dt : 0;
		inRock = inSolid ? inRock + dt : 0;
		if (belowWorld || water >= waterTime || inRock >= rockTime)
		{
			water = inRock = 0;
			return true;
		}
		return false;
	}
};
