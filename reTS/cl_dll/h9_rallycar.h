// H9 rally mode on the client: the player that is a car is drawn as one, and the local player has HL Rally's views (chase, bonnet, side,
// interior with its mirror), the weapon and the parts of TS's HUD that mean nothing in a car gone. The arithmetic is in h9_rallycam_calc.h (tested by
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
	bool hasShock; // the local car: the four suspension offsets below are to be applied (h9_rallycam_calc.h kShockBone)
	float shock[4]; // frontRight, frontLeft, backLeft, backRight: added to the z of SHOCK-RghFron, SHOCK-LefFron, SHOCK-LefBack, SHOCK-RghBack
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
bool H9RallyCar_ModeOn();       // rally mode is on for the local player (the physinfo key "rally"): what a key layout (h9_keymap.cpp) asks
bool H9RallyCam_LocalIsCar();
// ...and is seen from outside (chase, bonnet or side view: the engine then draws the local player's model, and the TS code sees a third-person view).
bool H9RallyCam_ChaseActive();
// Called by V_CalcNormalRefdef at the end of its work: replaces the view origin and angles by the car's camera and takes the weapon
// away. False (nothing touched) when the local player is not a car.
bool H9RallyCam_Apply(struct ref_params_s* pparams, struct cl_entity_s* viewmodel);

// The rear-view mirror (HL Rally's second view pass through ref_params.nextView, interior view only, cvar cl_h9_rally_rearview). Begin: at the
// end of V_CalcRefdef's first pass, asks the engine for a second; Pass: at the start of the second, sets the rectangle and turns the view round.
// Pass returns true when it handled the call (V_CalcRefdef then does nothing else).
void H9RallyCam_MirrorBegin(struct ref_params_s* pparams);
bool H9RallyCam_MirrorPass(struct ref_params_s* pparams);
// For the studio renderer, drawing the view model `drawn`: the interior's windscreen overlay model, or null.
struct model_s* H9RallyCam_InteriorChrome(const struct model_s* drawn);

// ---- the steering (h9_rallysteer_calc.h; the client's half of HL Rally's rule) -----------------------------------------------------
// CL_CreateMove, while the local player is a car: the mouse and the keys are an INPUT; the heading is kept here and is what goes to the
// server and the prediction as the view yaw. The arrow keys' stock yaw and the mouse's yaw are not applied to it.

// What the keys say this frame.
struct H9RallyKeys
{
	float frametime;
	float left, right; // the side keys (A, D and the arrows), 0..1
	bool throttle, brake, handbrake; // the keys: the forward key, the back key, the jump key
	// HL Rally's globals as DriveStep leaves them this frame (the steering, the wheels, the sounds read these, not the keys)
	bool accelerating; // g_accelerating
	bool braking;      // g_braking
	int reversing;     // g_reversing
};

// ---- the throttle (h9_rallysteer_calc.h DriveStep; input.cpp's half of HL Rally's CL_CreateMove:869-1001) -------------------------------
// CL_CreateMove, while the local player is a car on the ground-and-air of a race: the forward move the command carries is worked out from the
// gearbox and the speed, as HL Rally does, not from "a key is down". The keys are given as HL Rally's reads of them see them: `Frac` is the
// first CL_KeyState of a frame (0.25 .. 0.75 for a tap or an edge), `Down` the next one (1 if down, 0 if not).
struct H9RallyDriveKeys
{
	float backFrac, backDown, fwdFrac, fwdDown;
	bool klook;
};
struct H9RallyDriveResult
{
	float forwardmove; // before the maxspeed clip; 0 in the air
	bool accelerating, braking;
	int reversing;
};
H9RallyDriveResult H9RallyDrive_Move(const H9RallyDriveKeys& keys);
// The input model's log (cvar cl_h9_rally_log, rallylog/cl_<map>_<date-time>.txt): CL_CreateMove calls this once a frame for a car, with the
// finished command.
void H9RallyLog_Frame(const struct usercmd_s* cmd, float frametime);
// After the finish (physinfo "rfin"): the heading is left as it stands and nothing is pressed; only the revs follow the speed.
void H9RallyDrive_Frozen(float frametime);
// The race's finish for this car (physinfo "rfin").
bool H9RallyDrive_Finished();


// Before the mouse is read: the heading the view's yaw is to hold now. `viewYaw` is what the engine holds (it differs from what was last
// written when the server forced the angles: the car is then started again from it).
float H9RallySteer_Begin(float viewYaw);
// CL_CreateMove when the local player is not a car: nothing is kept.
void H9RallySteer_Idle();
// IN_MouseMove, while Begin has been called this frame: the mouse is to be filtered, scaled by cl_h9_rally_mouse and ignored in the air.
bool H9RallySteer_MouseActive();
bool H9RallySteer_OnGround();
float H9RallySteer_MouseScale();
// After the mouse has turned the view: the heading, from the mouse's turn (`viewYaw` less what Begin returned) and the keys.
float H9RallySteer_End(float viewYaw, const H9RallyKeys& keys);
// The car's predicted state this frame (from the refdef, V_CalcRefdef): what the steering reads next frame.
void H9RallySteer_NoteView(const float simorg[3], const float simvel[3], bool onGround, float time);
// The local car's speed for the HUD: the full velocity's length, and the part along the nose. False when the local player is not a car.
bool H9RallyCar_LocalSpeed(float& speed3d, float& alongNose);
// HL Rally's +camdistance held (+h9_camdistance) in a view from outside: IN_MouseMove gives the frame's vertical mouse movement to the camera's
// distance (H9RallyCam_ZoomMouse) and the mouse does not steer.
bool H9RallyCam_ZoomHeld();
void H9RallyCam_ZoomMouse(int dy);
// The FOV the car's view wants (HL Rally's 90), or 0 for the player's own.
float H9RallyCam_Fov();

// What the sounds read of the local car (h9_rallysnd.cpp): the steering's gearbox (HL Rally's revs and gear), the predicted velocity and origin when
// the last refdef noted them (`valid`), and the keys of the last CL_CreateMove. False when the local player is not a car.
struct H9RallyDriveNote
{
	bool valid;
	float rpm;
	int gear;
	float tractionLoss;
	float vel[3], org[3];
	float heading;
	int carClass; // the physinfo "rally" value, 1..3
	bool onGround;
	bool throttle, brake, handbrake;
	bool manual;   // cl_h9_rally_manual: the gear is the driver's (h9_gearup, h9_geardown), -1 reverse, 0 neutral
	int reversing; // HL Rally's g_reversing (0, 1, 2)
};
bool H9RallyCar_DriveNote(H9RallyDriveNote& out);
