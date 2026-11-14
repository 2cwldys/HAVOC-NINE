// ---- H9 rally car menu: the arithmetic, with no engine (tested by tests/carmenu_test.cpp) -----------------------------------------------
// HL Rally's main menu, car menu (make, then model) and Customise shop, as behaviour and layout numbers (its 640 x 480 virtual units, which the
// menus turn into pixels with XRES and YRES, as reTS's own menus do). The numbers are facts of that screen; the code and every word of it are ours.
// What this file holds: where each piece stands, the queue of commands that the two-stage flow keeps until "Race", the money and the bars, the
// text formats, the showroom car's place, spin and drag, and the shadow's corners. h9_carmenu.cpp is the engine's side, vgui_H9RallyMenu.cpp the
// panels. The contract with the server is pm_shared/h9_rally_shop.h.
#pragma once

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../pm_shared/h9_rally.h"
#include "../pm_shared/h9_rally_shop.h"

namespace carmenu
{
// A rectangle in the 640 x 480 virtual units.
struct Box
{
	float x, y, w, h;
};

// ---- the cars as the menu lists them: the makes in order of first appearance, then the models of a make in class order ------------------------
inline int NumMakes()
{
	int n = 0;
	for (int c = 0; c < H9R_NUM_CARS; c++)
	{
		bool seen = false;
		for (int k = 0; k < c; k++)
			seen = seen || strcmp(g_h9RallyCarShow[k].make, g_h9RallyCarShow[c].make) == 0;
		if (!seen)
			n++;
	}
	return n;
}
inline const char* MakeName(int make) // 0-based; "" when there is none
{
	int n = 0;
	for (int c = 0; c < H9R_NUM_CARS; c++)
	{
		bool seen = false;
		for (int k = 0; k < c; k++)
			seen = seen || strcmp(g_h9RallyCarShow[k].make, g_h9RallyCarShow[c].make) == 0;
		if (seen)
			continue;
		if (n == make)
			return g_h9RallyCarShow[c].make;
		n++;
	}
	return "";
}
// The classes (1..H9R_NUM_CARS) of a make's models, in class order; returns how many.
inline int ModelsOfMake(int make, int* classes, int cap)
{
	const char* name = MakeName(make);
	int n = 0;
	for (int c = 0; c < H9R_NUM_CARS && n < cap; c++)
		if (strcmp(g_h9RallyCarShow[c].make, name) == 0)
			classes[n++] = c + 1;
	return n;
}
inline int MaxModelsPerMake()
{
	int best = 0;
	for (int m = 0; m < NumMakes(); m++)
	{
		int cls[H9R_NUM_CARS];
		const int n = ModelsOfMake(m, cls, H9R_NUM_CARS);
		best = n > best ? n : best;
	}
	return best;
}
inline int MakeOfClass(int cls) // 0-based make of a class, -1 when it is none
{
	if (cls < 1 || cls > H9R_NUM_CARS)
		return -1;
	for (int m = 0; m < NumMakes(); m++)
		if (strcmp(MakeName(m), g_h9RallyCarShow[cls - 1].make) == 0)
			return m;
	return -1;
}
// The three bars of a car: acceleration, handling, top speed, in % (0 when the class is none).
inline void StatsOf(int cls, int out[3])
{
	out[0] = out[1] = out[2] = 0;
	if (cls < 1 || cls > H9R_NUM_CARS)
		return;
	out[0] = (int)g_h9RallyCars[cls - 1].accelStat;
	out[1] = (int)g_h9RallyCars[cls - 1].handlingStat;
	out[2] = (int)g_h9RallyCars[cls - 1].topStat;
}

// ---- the parts: four classes, their names (HL Rally's customise.txt headings) -------------------------------------------------------------
inline const char* PartClassName(int pc)
{
	static const char* const n[H9R_NUM_PART_CLASSES] = {"Tyres", "Exhaust", "Intercooler", "Turbo"};
	return (pc >= 0 && pc < H9R_NUM_PART_CLASSES) ? n[pc] : "";
}
// The parts of a class, in table order; returns how many.
inline int PartsOfClass(int pc, int* parts, int cap)
{
	int n = 0;
	for (int p = 0; p < H9R_NUM_PARTS && n < cap; p++)
		if (g_h9RallyParts[p].partClass == pc)
			parts[n++] = p;
	return n;
}
// The effect line as HL Rally formats a Value: "Stat + N", several joined by "; ". Our table has acceleration, handling and top speed; the
// order is top speed, handling, acceleration, so the turbo reads "TopSpeed + 15; Acceleration + 15".
inline int EffectText(int part, char* out, int cap)
{
	out[0] = 0;
	if (part < 0 || part >= H9R_NUM_PARTS || cap < 2)
		return 0;
	const H9RallyPart& p = g_h9RallyParts[part];
	char* w = out;
	int left = cap;
	const struct
	{
		const char* name;
		int v;
	} e[3] = {{"TopSpeed", p.top}, {"Handling", p.handling}, {"Acceleration", p.accel}};
	for (int i = 0; i < 3; i++)
	{
		if (e[i].v == 0)
			continue;
		const int n = snprintf(w, left, "%s%s + %d", w == out ? "" : "; ", e[i].name, e[i].v);
		if (n < 0 || n >= left)
		{
			out[cap - 1] = 0;
			return (int)strlen(out);
		}
		w += n;
		left -= n;
	}
	return (int)(w - out);
}
inline void CostText(int part, char* out, int cap) // "Cost: $%i.00"
{
	snprintf(out, cap, "Cost: $%i.00", (part >= 0 && part < H9R_NUM_PARTS) ? g_h9RallyParts[part].cost : 0);
}
inline void MoneyText(int money, char* out, int cap) // "Money: $%i"
{
	snprintf(out, cap, "Money: $%i", money);
}
static const int kMoneyR = 0, kMoneyG = 198, kMoneyB = 0; // the label's green

// ---- the layout ------------------------------------------------------------------------------------------------------------------------------
// Main menu (HL Rally vgui_mainmenu.cpp).
static const Box kMainTitle = {40, 10, 0, 0};
static const Box kMainLogo = {230, 4, 0, 0};
static const Box kMoneyLabel = {550, 80, 0, 0}; // the same on all three screens
static const Box kMapInfo = {550, 100, 80, 100};
inline Box MainButton(int i) // 0 Select Car, 1 Customise, 2 Spectate, 3 Race: the pitch is 26 and there is a gap of one before Race
{
	const float y = i < 3 ? 80.0f + 26.0f * i : 80.0f + 26.0f * 3 + 26.0f;
	return Box{40, y, 100, 20};
}
static const Box kMotdWindow = {40, 240, 362, 220};
inline Box MotdScroll() // 16 in from the window's left and top, 32 less wide, 16 less tall
{
	return Box{kMotdWindow.x + 16, kMotdWindow.y + 16, kMotdWindow.w - 32, kMotdWindow.h - 16};
}
static const Box kPartsWindow = {402, 240, 200, 220}; // the Inventory: right of the MOTD, 402 = 40 + 362
inline float PartsInfoY() { return kMotdWindow.h - kMotdWindow.h / 3.0f; } // the bars' labels (the integer thirds of 220: 146.67)
static const float kBarTop = 50, kBarW = 20, kBarGap = 35;
inline float PartsBarH() { return PartsInfoY() - kBarTop - 10; } // HL Rally subtracts XRES(10) here: the same 10 at 4:3
inline Box PartsBar(int i) // 0 acceleration, 1 handling, 2 top speed: inside the Inventory panel
{
	return Box{kBarGap + i * (kBarW + kBarGap), kBarTop, kBarW, PartsBarH()};
}
inline Box PartsBarLabel(int i) // the labels sit 10 left of their bar, on the panel's info line
{
	return Box{kBarGap - 10 + i * (kBarW + kBarGap), PartsInfoY(), 0, 0};
}
static const Box kPartsTitle = {10, 10, 0, 0};

// Car menu (HL Rally vgui_teammenu.cpp): the makes in a column at x 20, the models of the make at x 124, the statistics window at (230, 80).
static const Box kCarTitle = {40, 10, 0, 0};
static const float kCarButtonW = 100, kCarButtonH = 20, kCarButtonPitch = 26;
static const Box kCarMakeLabel = {20, 80, 0, 0};
static const Box kCarModelLabel = {124, 80, 0, 0};
inline int ModelSlots() { return MaxModelsPerMake() > 3 ? MaxModelsPerMake() : 3; } // HL Rally had three rows; a make of ours has four
inline Box CarMakeButton(int i) { return Box{20, 110 + kCarButtonPitch * i, kCarButtonW, kCarButtonH}; }
inline Box CarModelButton(int i) { return Box{124, 110 + kCarButtonPitch * i, kCarButtonW, kCarButtonH}; }
inline Box CarCancelButton() { return Box{124, 110 + kCarButtonPitch * ModelSlots(), kCarButtonW, kCarButtonH}; }
inline Box CarSpectateButton() { return Box{124, 110 + kCarButtonPitch * (ModelSlots() + 1), kCarButtonW, kCarButtonH}; } // below Cancel
static const Box kCarStatWindow = {230, 80, 374, 176};
static const Box kCarStatTitle = {16, 16, 0, 0};         // inside the window
static const float kCarStatLabelX = 176, kCarStatBarX = 260, kCarStatRow0 = 86, kCarStatPitch = 20; // rows of acceleration, handling, top speed
static const float kCarStatBarW = 100, kCarStatBarH = 15;
static const Box kCarModelWindow = {124, 256, 480, 216}; // takes the mouse; HL Rally's width is YRES(480) (the same 480 at 4:3)
static const Box kCarModelHint = {16, 196, 0, 0};        // inside the model window, centred

// Customise (HL Rally vgui_ClassMenu.cpp).
static const Box kCustTitle = {40, 10, 0, 0};
static const Box kCustClassLabel = {40, 80, 0, 0};
static const Box kCustPartLabel = {124, 80, 0, 0};
static const float kCustButtonW = 110, kCustButtonH = 20, kCustButtonPitch = 28;
static const int kCustChoiceRows = 4; // HL Rally's MAX_CUST_CHOICES: the rows of part buttons; Cancel stands under the fourth
inline Box CustClassButton(int i) { return Box{40, 110 + kCustButtonPitch * i, kCustButtonW, kCustButtonH}; }
static const Box kCustPartsPanel = {124, 110, 110, 160}; // the panel the part buttons stand in (HL Rally: 8 rows high)
inline Box CustPartButton(int i) { return Box{0, kCustButtonPitch * i, kCustButtonW, kCustButtonH}; } // in that panel
inline Box CustCancelButton() { return Box{0, kCustButtonPitch * kCustChoiceRows, kCustButtonW, kCustButtonH}; }
static const Box kCustInfoWindow = {230, 80, 374, 176};
static const Box kCustInfoTitle = {16, 16, 0, 0};
inline Box CustInfoText() { return Box{16, 46, kCustInfoWindow.w - 16 - 16, kCustInfoWindow.h - 46 - 36}; }
static const Box kCustEffect = {250, 140, 0, 0};
static const Box kCustCost = {250, 160, 0, 0};
static const Box kCustPorthole = {160, 275, 340, 180}; // the window the car shows in; the rest of the screen is black

// ---- the commands the two stages keep until "Race" ---------------------------------------------------------------------------------------------
// HL Rally keeps one string of commands, adds to it as the player picks a car or a part, and sends it all when he presses Race (or at once when he
// is a spectator). A pick of a car and a purchase are two kinds of event here, kept in order.
enum EvKind
{
	EV_CAR = 0, // changecar <class>
	EV_BUY = 1  // buy <part>
};
struct Event
{
	int kind;
	int arg;
};
static const int kMaxEvents = 16; // HL Rally's string was 256 bytes: about this many commands

struct Session
{
	// what the server last said (H9RCar, H9RMoney, H9RParts)
	int serverCar = 0;
	int money = 0;
	unsigned owned = 0;
	// what the player has picked and not sent
	Event ev[kMaxEvents];
	int nev = 0;
	int remembered = 0; // the car last sent or told by the server (HL Rally's m_szModel)

	// ---- the server's word
	void SetCar(int cls)
	{
		serverCar = remembered = (cls >= 0 && cls <= H9R_NUM_CARS) ? cls : 0;
	}
	void SetMoney(int m) { money = m < 0 ? 0 : m; }
	void SetParts(unsigned mask) { owned = mask & ((1u << H9R_NUM_PARTS) - 1u); }
	void Reset() { *this = Session(); } // a new map: nothing is known

	// ---- the picks
	int PickedCar() const // the last car picked, else the car the server gave
	{
		for (int i = nev - 1; i >= 0; i--)
			if (ev[i].kind == EV_CAR)
				return ev[i].arg;
		return serverCar;
	}
	bool HasPick() const // Customise and Race show once a car is picked (HL Rally: the string holds a changecar)
	{
		for (int i = 0; i < nev; i++)
			if (ev[i].kind == EV_CAR)
				return true;
		return serverCar > 0;
	}
	int PendingSpend() const
	{
		int s = 0;
		for (int i = 0; i < nev; i++)
			if (ev[i].kind == EV_BUY && ev[i].arg >= 0 && ev[i].arg < H9R_NUM_PARTS)
				s += g_h9RallyParts[ev[i].arg].cost;
		return s;
	}
	// The money as shown: the server's, less what the queue has promised to spend. HL Rally takes the price off its own figure at the click.
	int ShownMoney() const
	{
		const int m = money - PendingSpend();
		return m < 0 ? 0 : m;
	}
	// A car picked: the one picked before is no longer wanted, so one car is queued at most (HL Rally appended another changecar to its string and
	// let the server run both); the purchases made stay, in order.
	bool Pick(int cls)
	{
		if (cls < 1 || cls > H9R_NUM_CARS)
			return false;
		int k = 0;
		for (int i = 0; i < nev; i++)
			if (ev[i].kind != EV_CAR)
				ev[k++] = ev[i];
		nev = k;
		if (nev >= kMaxEvents)
			return false;
		ev[nev].kind = EV_CAR;
		ev[nev].arg = cls;
		nev++;
		return true;
	}
	enum BuyResult
	{
		BUY_OK = 0,
		BUY_NO_FUNDS, // HL Rally: "Insufficient Funds", nothing queued (only a price above the figure refuses: the whole sum may be spent)
		BUY_BAD,
		BUY_FULL
	};
	BuyResult Buy(int part)
	{
		if (part < 0 || part >= H9R_NUM_PARTS)
			return BUY_BAD;
		if (g_h9RallyParts[part].cost > ShownMoney())
			return BUY_NO_FUNDS;
		if (nev >= kMaxEvents)
			return BUY_FULL;
		ev[nev].kind = EV_BUY;
		ev[nev].arg = part;
		nev++;
		return BUY_OK;
	}

	// The part held in each of the four classes (-1 none), as HL Rally's upgrade slots: they begin as the parts owned, a car different from the one
	// in use clears them, and each purchase puts its part in its class.
	void Slots(int slot[H9R_NUM_PART_CLASSES]) const
	{
		for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
			slot[c] = -1;
		for (int p = 0; p < H9R_NUM_PARTS; p++)
			if (owned & (1u << p))
				slot[g_h9RallyParts[p].partClass] = p; // a class holds one part: the later one of the table, if ever two
		int car = serverCar;
		for (int i = 0; i < nev; i++)
		{
			if (ev[i].kind == EV_CAR)
			{
				if (ev[i].arg != car)
					for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
						slot[c] = -1;
				car = ev[i].arg;
			}
			else if (ev[i].arg >= 0 && ev[i].arg < H9R_NUM_PARTS)
				slot[g_h9RallyParts[ev[i].arg].partClass] = ev[i].arg;
		}
	}
	// The stats added by what is held: acceleration, handling, top speed.
	void Added(int add[3]) const
	{
		int slot[H9R_NUM_PART_CLASSES];
		Slots(slot);
		add[0] = add[1] = add[2] = 0;
		for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
		{
			if (slot[c] < 0)
				continue;
			add[0] += g_h9RallyParts[slot[c]].accel;
			add[1] += g_h9RallyParts[slot[c]].handling;
			add[2] += g_h9RallyParts[slot[c]].top;
		}
	}
	// The Inventory's bars: the green of each is the car's stat, the red from there up to stat + added (to 100: the bar's height).
	void Bars(int stat[3], int total[3]) const
	{
		StatsOf(PickedCar(), stat);
		int add[3];
		Added(add);
		for (int i = 0; i < 3; i++)
		{
			total[i] = stat[i] + add[i];
			if (total[i] > 100)
				total[i] = 100;
			if (stat[i] > 100)
				stat[i] = 100;
		}
	}

	// What Race sends. HL Rally takes the car out of the string when it is the car in use and the player is not a spectator (a purchase in the
	// middle of a race does not respawn the car); the string is then what remains. The queue is emptied but for the car, which keeps Customise and
	// Race showing; the figures follow what was sent until the server says otherwise. Returns the commands' length (0 when there are none).
	int Execute(bool spectating, char* out, int cap)
	{
		out[0] = 0;
		const int pick = PickedCar();
		const bool dropCar = (pick == remembered) && !spectating;
		int slot[H9R_NUM_PART_CLASSES];
		Slots(slot);
		const int spend = PendingSpend();
		char* w = out;
		int left = cap;
		for (int i = 0; i < nev; i++)
		{
			if (ev[i].kind == EV_CAR && dropCar)
				continue;
			const int n = (ev[i].kind == EV_CAR) ? snprintf(w, left, "changecar %d;", ev[i].arg) : snprintf(w, left, "buy %d;", ev[i].arg);
			if (n < 0 || n >= left)
				break;
			w += n;
			left -= n;
		}
		const int len = (int)(w - out);
		if (!dropCar)
			remembered = pick;
		// the figures as they will be
		owned = 0;
		for (int c = 0; c < H9R_NUM_PART_CLASSES; c++)
			if (slot[c] >= 0)
				owned |= 1u << slot[c];
		serverCar = pick;
		money = money - spend < 0 ? 0 : money - spend;
		nev = 0;
		if (pick > 0)
		{
			ev[0].kind = EV_CAR;
			ev[0].arg = pick;
			nev = 1;
		}
		return len;
	}
};

// ---- the main menu's two hidden buttons ----------------------------------------------------------------------------------------------------
inline bool MainButtonShown(int i, bool hasPick) { return i == 0 || i == 2 || hasPick; } // Customise (1) and Race (3) wait for a car

// ---- the showroom (HL Rally rally_vguifx.cpp) -----------------------------------------------------------------------------------------------
static const float kShowFwd = 65, kShowRight = 9, kShowUp = -23; // vg_x, vg_y, vg_z
static const float kSpinPerSecond = 99.0f;                        // one degree a frame at 99 frames a second
static const float kShowStartYaw = -180.0f;
static const int kShowSkins = 8; // the car model's liveries (dlls/race_rally.h RaceRallySkin)
static const float kShowLightRadius = 70;
static const int kShowLightR = 120, kShowLightG = 120, kShowLightB = 130;
static const float kShadowLength = 26, kShadowWidth = 12;

inline int ShowSkin(int cls) { return cls < 1 ? 0 : (cls - 1) % kShowSkins; }

// The engine's AngleVectors: pitch positive looks down, yaw turns left, roll leans.
inline void Vectors(const float ang[3], float f[3], float r[3], float u[3])
{
	const float d = 3.14159265358979f / 180.0f;
	const float sp = sinf(ang[0] * d), cp = cosf(ang[0] * d);
	const float sy = sinf(ang[1] * d), cy = cosf(ang[1] * d);
	const float sr = sinf(ang[2] * d), cr = cosf(ang[2] * d);
	f[0] = cp * cy;
	f[1] = cp * sy;
	f[2] = -sp;
	r[0] = -1 * sr * sp * cy + -1 * cr * -sy;
	r[1] = -1 * sr * sp * sy + -1 * cr * cy;
	r[2] = -1 * sr * cp;
	u[0] = cr * sp * cy + -sr * -sy;
	u[1] = cr * sp * sy + -sr * cy;
	u[2] = cr * cp;
}
// Where the showroom car stands: the view's origin, 65 ahead, 9 to the right, 23 down.
inline void ShowPlace(const float org[3], const float ang[3], float out[3])
{
	float f[3], r[3], u[3];
	Vectors(ang, f, r, u);
	for (int i = 0; i < 3; i++)
		out[i] = org[i] + f[i] * kShowFwd + r[i] * kShowRight + u[i] * kShowUp;
}

struct Spin
{
	float yaw = kShowStartYaw;
	int dir = 1;
	bool down = false; // the mouse holds the car
};
inline float WrapYaw(float y)
{
	while (y > 180.0f)
		y -= 360.0f;
	while (y <= -180.0f)
		y += 360.0f;
	return y;
}
// One frame: the car turns by its direction unless the mouse holds it.
inline void SpinFrame(Spin& s, float dt)
{
	if (s.down || dt <= 0.0f)
		return;
	if (dt > 0.1f)
		dt = 0.1f;
	s.yaw = WrapYaw(s.yaw + (float)s.dir * kSpinPerSecond * dt);
}
// The mouse moved by (dx, dy) with a button down: the left button adds both, the right takes both (HL Rally turns the car one degree a pixel on
// either axis); the spin goes on the way it was last dragged.
inline void DragMove(Spin& s, int button, int dx, int dy)
{
	const float d = (float)(dx + dy) * (button == 2 ? -1.0f : 1.0f);
	if (button != 1 && button != 2)
		return;
	if (d > 0.0f)
		s.dir = 1;
	else if (d < 0.0f)
		s.dir = -1;
	s.yaw = WrapYaw(s.yaw + d);
}

// The shadow under the car: a quad 26 long and 12 wide on the car's origin, by the car's yaw. Order: front left, back left, back right, front right.
inline void ShadowCorners(const float org[3], float yaw, float out[4][3])
{
	const float ang[3] = {0, yaw, 0};
	float f[3], r[3], u[3];
	Vectors(ang, f, r, u);
	const float L = kShadowLength, W = kShadowWidth;
	for (int i = 0; i < 3; i++)
	{
		out[0][i] = org[i] + f[i] * L - r[i] * W;
		out[1][i] = org[i] - f[i] * L - r[i] * W;
		out[2][i] = org[i] - f[i] * L + r[i] * W;
		out[3][i] = org[i] + f[i] * L + r[i] * W;
	}
}

// ---- the map's text for the main menu ---------------------------------------------------------------------------------------------------------
// "maps/<map>.bsp" -> "maps/<map>_mapinfo.txt" (HL Rally cuts the last four characters of the level name); false when the name is too short.
inline bool MapInfoPath(const char* level, char* out, int cap)
{
	out[0] = 0;
	if (level == nullptr)
		return false;
	const int n = (int)strlen(level);
	if (n < 5 || n - 4 + 13 >= cap)
		return false;
	memcpy(out, level, n - 4);
	out[n - 4] = 0;
	strcat(out, "_mapinfo.txt");
	return true;
}
static const char* const kMapInfoDefault = "maps/default_mapinfo.txt";
} // namespace carmenu
