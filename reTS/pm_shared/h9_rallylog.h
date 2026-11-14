/***
*  h9_rallylog.h -- rally mode's log files (H9). Engine-free: dlls/tests/rally_test.cpp compiles it alone.
*
*  Two files per map load, in <gamedir>/rallylog/:
*    srv_<map>_<date-time>.txt   the server: one CSV line for every pmove command of every rally car (H9RallyLogRec, filled by
*                                pm_shared/h9_rally.cpp, written by dlls/h9_rally_srv.cpp after PM_Move). Cvar h9_rally_log.
*    cl_<map>_<date-time>.txt    the client: one CSV line for every frame of the local car's input model (cl_dll/h9_rallycar.cpp).
*                                Cvar cl_h9_rally_log.
*  The files are buffered and flushed about once a second, and one stops at 50 MB (a last line says so).
*
*  The server's file is the record of what the game did, command by command: the usercmd, the state before and after, the tilt kept
*  and the car's notes. It is enough to feed the same commands to another build of the movement and compare (a replay).
***/
#pragma once

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <time.h>
#include <math.h>
#ifdef _WIN32
#include <direct.h>
#define H9RL_MKDIR(p) _mkdir(p)
#else
#include <sys/stat.h>
#define H9RL_MKDIR(p) mkdir((p), 0755)
#endif

#define H9RALLYLOG_MAX_BYTES (50LL * 1024 * 1024)

// ------------------------------------------------------------------------------------------------------------
//  The record of one server pmove command: filled by H9RallyMove when g_h9RallyLogWanted is set.
// ------------------------------------------------------------------------------------------------------------
struct H9RallyLogRec
{
	bool valid;
	int player;                  // pmove->player_index (the entity index is this + 1)
	float time;                  // pmove->time / 1000 (the server's clock)
	int msec;                    // the command's length
	float forward, side, up;     // the usercmd: forwardmove, sidemove, upmove (as pmove read them, after PM_CheckParamters)
	int buttons;
	float view[3];               // the command's viewangles
	int impulse;
	float org0[3], vel0[3], base0[3]; // the state when pmove was called
	int onground0;
	float org[3], vel[3], base[3];    // and after the command
	int onground, groundEnt;     // pmove->onground (a physent index, -1 none) and that physent's entity number
	int flags;
	float tilt0[3];              // the kept tilt before (pitch, yaw, roll); tiltValid 0: none was kept (read as 0 0 0)
	int tiltValid;
	float tilt[3];               // the kept tilt after
	float normal[3];             // the up of the car's ground (the tilt's plane)
	float gap;                   // the ground's distance under the car
	char tex[20];
	char surf[16];
	int usehull;
	float wishspeed, wanted, got;
	float crash;                 // g_h9RallyCrashAmount: the velocity along the wall's normal at the body check
	int stepped, toss, held, stuck;
	float friction, gravity, fuser1, maxspeed, cmaxspeed;
	int rally, rh, rt, rhull;    // the physinfo keys
};

#define H9RALLYLOG_SRV_HEADER                                                                                                      \
	"seq,t,player,msec,fwd,side,up,buttons,view_p,view_y,view_r,impulse,"                                                           \
	"ox0,oy0,oz0,vx0,vy0,vz0,bx0,by0,bz0,gnd0,"                                                                                     \
	"ox,oy,oz,vx,vy,vz,bx,by,bz,onground,gndent,flags,"                                                                             \
	"tilt0_p,tilt0_y,tilt0_r,tilt0_valid,tilt_p,tilt_y,tilt_r,nx,ny,nz,gap,tex,surf,usehull,wishspeed,want,got,crash,"             \
	"stepped,toss,held,stuck,friction,gravity,fuser1,maxspeed,cmaxspeed,rally,rh,rt,rhull,speedh"

// One CSV line (no newline) for a record. Floats with 9 significant digits: a float prints back to the same float.
static inline int H9RallyLogFormatSrv(char* out, int size, int seq, const H9RallyLogRec& r)
{
	const float sp = sqrtf(r.vel[0] * r.vel[0] + r.vel[1] * r.vel[1]);
	const char* tex = r.tex[0] ? r.tex : "-";
	const char* surf = r.surf[0] ? r.surf : "-";
	return snprintf(out, size,
		"%d,%.4f,%d,%d,%.9g,%.9g,%.9g,%d,%.9g,%.9g,%.9g,%d,"
		"%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%d,"
		"%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%d,%d,%d,"
		"%.9g,%.9g,%.9g,%d,%.9g,%.9g,%.9g,%.5g,%.5g,%.5g,%.5g,%s,%s,%d,%.5g,%.5g,%.5g,%.5g,"
		"%d,%d,%d,%d,%.5g,%.5g,%.5g,%.5g,%.5g,%d,%d,%d,%d,%.5f",
		seq, r.time, r.player, r.msec, r.forward, r.side, r.up, r.buttons, r.view[0], r.view[1], r.view[2], r.impulse,
		r.org0[0], r.org0[1], r.org0[2], r.vel0[0], r.vel0[1], r.vel0[2], r.base0[0], r.base0[1], r.base0[2], r.onground0 != -1 ? 1 : 0,
		r.org[0], r.org[1], r.org[2], r.vel[0], r.vel[1], r.vel[2], r.base[0], r.base[1], r.base[2], r.onground != -1 ? 1 : 0, r.groundEnt,
		r.flags,
		r.tilt0[0], r.tilt0[1], r.tilt0[2], r.tiltValid, r.tilt[0], r.tilt[1], r.tilt[2], r.normal[0], r.normal[1], r.normal[2], r.gap, tex,
		surf, r.usehull, r.wishspeed, r.wanted, r.got, r.crash, r.stepped, r.toss, r.held, r.stuck, r.friction, r.gravity, r.fuser1,
		r.maxspeed, r.cmaxspeed, r.rally, r.rh, r.rt, r.rhull, sp);
}

// ------------------------------------------------------------------------------------------------------------
//  One log file: opened when asked, buffered, flushed about once a second, closed at the cap.
// ------------------------------------------------------------------------------------------------------------
struct H9RallyLogFile
{
	FILE* f = nullptr;
	long long bytes = 0;
	clock_t lastFlush = 0;
	bool capped = false;
	long long cap = H9RALLYLOG_MAX_BYTES;
	char path[512] = "";

	bool IsOpen() const { return f != nullptr; }

	// <gamedir>/rallylog/<prefix>_<map>_<date-time>.txt with `header` as its first line. False when it cannot be made.
	bool Open(const char* gameDir, const char* prefix, const char* map, const char* header)
	{
		Close();
		capped = false;
		bytes = 0;
		char dir[400];
		snprintf(dir, sizeof dir, "%s/rallylog", (gameDir && gameDir[0]) ? gameDir : ".");
		H9RL_MKDIR(dir); // already there is fine
		char safe[64];
		int n = 0;
		for (const char* p = map ? map : ""; *p && n < 60; p++)
			safe[n++] = (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '_' || *p == '-' ? *p : '_';
		safe[n] = 0;
		if (n == 0)
			strcpy(safe, "nomap");
		time_t now = time(nullptr);
		struct tm tmv;
#ifdef _WIN32
		localtime_s(&tmv, &now);
#else
		localtime_r(&now, &tmv);
#endif
		char stamp[32];
		strftime(stamp, sizeof stamp, "%Y%m%d-%H%M%S", &tmv);
		snprintf(path, sizeof path, "%s/%s_%s_%s.txt", dir, prefix, safe, stamp);
		f = fopen(path, "wb");
		if (!f)
			return false;
		static char s_buf[2][1 << 16]; // a bigger stdio buffer: the file is written in chunks, flushed by Flush
		static int s_which = 0;
		setvbuf(f, s_buf[s_which = 1 - s_which], _IOFBF, sizeof s_buf[0]);
		lastFlush = clock();
		return Line(header);
	}

	// One line (a newline is added). Flushes about once a second. At the cap a last line says so and the file is closed.
	bool Line(const char* text)
	{
		if (!f)
			return false;
		const size_t len = strlen(text);
		if (bytes + (long long)len + 1 > cap)
		{
			fputs("# stopped: the file reached its size cap\n", f);
			Close();
			capped = true;
			return false;
		}
		fwrite(text, 1, len, f);
		fputc('\n', f);
		bytes += (long long)len + 1;
		const clock_t c = clock();
		if (c - lastFlush >= CLOCKS_PER_SEC || c < lastFlush)
		{
			fflush(f);
			lastFlush = c;
		}
		return true;
	}

	void Close()
	{
		if (f)
		{
			fclose(f);
			f = nullptr;
		}
	}
};

// ------------------------------------------------------------------------------------------------------------
//  The client's line: the input model of one frame of the local car (cl_dll/h9_rallycar.cpp fills it, input.cpp calls it).
// ------------------------------------------------------------------------------------------------------------
struct H9RallyClientRec
{
	float time;                  // the client's clock
	float frametime;
	int keyFwd, keyBack, keyLeft, keyRight, keyJump; // the keys held (0 / 1)
	float keyLeftFrac, keyRightFrac;                 // the side keys as the steering reads them (0..1)
	float rpm;                   // the gearbox before the frame's step
	int gear;
	float rpmAfter;
	int gearAfter;
	int reversing;
	int accelerating, braking;
	float speedH;                // what the throttle saw: the predicted horizontal speed
	int onGround;
	float fwdSent;               // cmd->forwardmove
	float side, up;
	int buttons;
	float steerKeyYaw, steerMouseYaw; // the filter's input this frame (degrees, left positive)
	float steerDelta;            // the filter's state after: degrees per reference frame
	float wheel;
	float tractionLoss;
	float heading0, yawSent;     // the heading before, and the yaw the command carries
	int tiltValid;
	float tiltP, tiltY, tiltR;   // the last command's kept tilt (what the steering read)
	float camPitch, camRoll;     // the view tilt shown for the car: the camera's, and the body's (interior or chase)
	float modelPitch, modelRoll; // the car's body as drawn
	int viewMode;
	float org[3], vel[3];        // the predicted origin and velocity (the last refdef)
	int noteFresh;
};

#define H9RALLYLOG_CL_HEADER                                                                                                   \
	"t,ft,k_fwd,k_back,k_left,k_right,k_jump,left_frac,right_frac,rpm,gear,rpm_after,gear_after,reversing,accel,brake,speedh,"  \
	"ground,fwd_sent,side,up,buttons,steer_key_yaw,steer_mouse_yaw,steer_delta,wheel,traction_loss,heading0,yaw_sent,"            \
	"tilt_valid,tilt_p,tilt_y,tilt_r,cam_p,cam_r,model_p,model_r,view,ox,oy,oz,vx,vy,vz,note_fresh"

static inline int H9RallyLogFormatCl(char* out, int size, const H9RallyClientRec& r)
{
	return snprintf(out, size,
		"%.4f,%.5f,%d,%d,%d,%d,%d,%.3f,%.3f,%.4g,%d,%.4g,%d,%d,%d,%d,%.5g,"
		"%d,%.5g,%.5g,%.5g,%d,%.5g,%.5g,%.5g,%.5g,%.5g,%.6g,%.6g,"
		"%d,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%.5g,%d,%.6g,%.6g,%.6g,%.6g,%.6g,%.6g,%d",
		r.time, r.frametime, r.keyFwd, r.keyBack, r.keyLeft, r.keyRight, r.keyJump, r.keyLeftFrac, r.keyRightFrac, r.rpm, r.gear, r.rpmAfter,
		r.gearAfter, r.reversing, r.accelerating, r.braking, r.speedH, r.onGround, r.fwdSent, r.side, r.up, r.buttons, r.steerKeyYaw,
		r.steerMouseYaw, r.steerDelta, r.wheel, r.tractionLoss, r.heading0, r.yawSent, r.tiltValid, r.tiltP, r.tiltY, r.tiltR, r.camPitch,
		r.camRoll, r.modelPitch, r.modelRoll, r.viewMode, r.org[0], r.org[1], r.org[2], r.vel[0], r.vel[1], r.vel[2], r.noteFresh);
}
