// H9 rally mode on the client: the player that is a car is drawn as one, and the local player has two cameras (a chase one and the
// driver's), the weapon and the parts of TS's HUD that mean nothing in a car gone. The arithmetic is in h9_rallycam_calc.h (tested by
// tests/rallycam_test.cpp); this file asks the engine. Nothing here is sent or received: what makes a player a car is his box
// (mins.z 0, maxs.z 16, set by dlls/h9_rally_srv.cpp and sent by the engine to everyone), and for the local player also the physinfo
// key "rally" (pm_shared/h9_rally.h).
#pragma once

struct cl_entity_s;
struct entity_state_s;
struct ref_params_s;
struct model_s;

// What the studio renderer needs to draw one car this frame.
struct H9RallyCarDraw
{
	struct model_s* model;
	float origin[3];
	float angles[3]; // entity angles: pitch nose up, yaw, roll left side up (see h9_rallycam_calc.h)
	int skin;
	int steerByte; // both steering controllers
	float phase;   // the tyres' turn, 0..1 of the roll sequence
};

void H9RallyCam_Init();   // from CHud::Init: cl_h9_rallycam*, the command h9_rallycam
void H9RallyCam_VidInit(); // a map change: the model is looked up again, every car's memory cleared

// True when this entity state is a car by its box (the test every client can make).
bool H9RallyCar_IsCarState(const struct entity_state_s* st);
bool H9RallyCar_IsCarEntity(const struct cl_entity_s* ent);

// From HUD_AddEntity for every entity: a player that is a car has its tilt and wheels brought up to this frame and the race effects told.
void H9RallyCar_AddEntity(int type, struct cl_entity_s* ent);

// For the studio renderer: the pose of the car that `ent` (the player being drawn) is. False when the car's model cannot be had (the
// player is then drawn as a human, as without this file).
bool H9RallyCar_Pose(struct cl_entity_s* ent, const struct entity_state_s* st, H9RallyCarDraw& out);

// The local player is a car now (physinfo "rally", alive, not a spectator).
bool H9RallyCam_LocalIsCar();
// ...and is seen from behind (the engine then draws the local player's model, and the TS code sees a third-person view).
bool H9RallyCam_ChaseActive();
// Called by V_CalcNormalRefdef at the end of its work: replaces the view origin and angles by the car's camera and takes the weapon
// away. False (nothing touched) when the local player is not a car.
bool H9RallyCam_Apply(struct ref_params_s* pparams, struct cl_entity_s* viewmodel);
