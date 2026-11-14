// Checks the rally car menu and shop's arithmetic (h9_carmenu_calc.h) with no game: the cars as the menu lists them, the layout numbers (HL Rally's
// 640 x 480 units), the two-stage queue (pick, buy, Race), the money and the three bars with the parts' additions, the text formats, the showroom
// car's place, spin, drag and shadow, the map-info file name, and the `m` key in the two shipped key files.
//   cmake --build <dir> --target carmenu_test --config Release, then run carmenu_test
#include "../h9_carmenu_calc.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>

using namespace carmenu;

static int g_failed = 0, g_checked = 0;
#define CHECK(what) \
	do \
	{ \
		g_checked++; \
		if (!(what)) \
		{ \
			g_failed++; \
			printf("FAILED line %d: %s\n", __LINE__, #what); \
		} \
	} while (0)

static bool Near(float a, float b, float eps = 0.01f) { return fabsf(a - b) <= eps; }

static char* ReadFile(const char* name)
{
	char path[512];
	snprintf(path, sizeof(path), "%s", __FILE__); // .../cl_dll/tests/carmenu_test.cpp
	char* slash = strrchr(path, '/');
	char* back = strrchr(path, '\\');
	if (back > slash)
		slash = back;
	if (slash)
		*slash = 0;
	char full[640];
	snprintf(full, sizeof(full), "%s/../../game/ts/h9/keys/%s", path, name);
	FILE* f = fopen(full, "rb");
	if (!f)
		return nullptr;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char* t = (char*)malloc(n + 1);
	fread(t, 1, n, f);
	t[n] = 0;
	fclose(f);
	return t;
}

static void TestCars()
{
	CHECK(NumMakes() == 3);
	CHECK(strcmp(MakeName(0), "VOLKRA") == 0 && strcmp(MakeName(1), "AMBERLINE") == 0 && strcmp(MakeName(2), "KESTREL") == 0);
	CHECK(MakeName(3)[0] == 0 && MakeName(-1)[0] == 0);
	int cls[H9R_NUM_CARS];
	CHECK(ModelsOfMake(0, cls, H9R_NUM_CARS) == 3 && cls[0] == 1 && cls[1] == 3 && cls[2] == 8);
	CHECK(ModelsOfMake(1, cls, H9R_NUM_CARS) == 4 && cls[0] == 2 && cls[1] == 5 && cls[2] == 9 && cls[3] == 10);
	CHECK(ModelsOfMake(2, cls, H9R_NUM_CARS) == 3 && cls[0] == 4 && cls[1] == 6 && cls[2] == 7);
	CHECK(ModelsOfMake(1, cls, 2) == 2); // the cap holds
	CHECK(MaxModelsPerMake() == 4);
	CHECK(MakeOfClass(1) == 0 && MakeOfClass(5) == 1 && MakeOfClass(7) == 2 && MakeOfClass(0) == -1 && MakeOfClass(11) == -1);
	// every class is in exactly one make's list
	int seen[H9R_NUM_CARS + 1] = {0};
	for (int m = 0; m < NumMakes(); m++)
	{
		const int n = ModelsOfMake(m, cls, H9R_NUM_CARS);
		for (int i = 0; i < n; i++)
			seen[cls[i]]++;
	}
	bool once = true;
	for (int c = 1; c <= H9R_NUM_CARS; c++)
		once = once && seen[c] == 1;
	CHECK(once);
	int st[3];
	StatsOf(4, st);
	CHECK(st[0] == 90 && st[1] == 80 && st[2] == 70);
	StatsOf(3, st);
	CHECK(st[0] == 80 && st[1] == 90 && st[2] == 70);
	StatsOf(0, st);
	CHECK(st[0] == 0 && st[1] == 0 && st[2] == 0);
	// HL Rally's stats sum to 240 and so do ours
	bool sum = true;
	for (int c = 1; c <= H9R_NUM_CARS; c++)
	{
		StatsOf(c, st);
		sum = sum && st[0] + st[1] + st[2] == 240;
	}
	CHECK(sum);
}

static void TestParts()
{
	CHECK(strcmp(PartClassName(0), "Tyres") == 0 && strcmp(PartClassName(3), "Turbo") == 0 && PartClassName(4)[0] == 0);
	int parts[8];
	CHECK(PartsOfClass(H9R_PC_TYRES, parts, 8) == 3 && parts[0] == 0 && parts[2] == 2);
	CHECK(PartsOfClass(H9R_PC_EXHAUST, parts, 8) == 3);
	CHECK(PartsOfClass(H9R_PC_INTERCOOLER, parts, 8) == 2);
	CHECK(PartsOfClass(H9R_PC_TURBO, parts, 8) == 2 && parts[0] == 8 && parts[1] == 9);
	CHECK(PartsOfClass(H9R_PC_TYRES, parts, 1) == 1);
	CHECK(kCustChoiceRows >= 3); // no class has more parts than the rows

	char sz[96];
	EffectText(0, sz, sizeof(sz));
	CHECK(strcmp(sz, "Handling + 3") == 0);
	EffectText(3, sz, sizeof(sz));
	CHECK(strcmp(sz, "TopSpeed + 4") == 0);
	EffectText(6, sz, sizeof(sz));
	CHECK(strcmp(sz, "Acceleration + 4") == 0);
	EffectText(8, sz, sizeof(sz));
	CHECK(strcmp(sz, "TopSpeed + 15; Acceleration + 15") == 0);
	EffectText(9, sz, sizeof(sz));
	CHECK(strcmp(sz, "TopSpeed + 8; Acceleration + 15") == 0);
	CHECK(EffectText(99, sz, sizeof(sz)) == 0 && sz[0] == 0);
	char tiny[12];
	EffectText(8, tiny, sizeof(tiny)); // cut, never over
	CHECK(strlen(tiny) < sizeof(tiny));

	CostText(8, sz, sizeof(sz));
	CHECK(strcmp(sz, "Cost: $4500.00") == 0);
	CostText(0, sz, sizeof(sz));
	CHECK(strcmp(sz, "Cost: $300.00") == 0);
	MoneyText(600, sz, sizeof(sz));
	CHECK(strcmp(sz, "Money: $600") == 0);
	CHECK(kMoneyR == 0 && kMoneyG == 198 && kMoneyB == 0);
}

static void TestLayout()
{
	// the main menu's four buttons: pitch 26, and a gap of one before Race
	CHECK(Near(MainButton(0).y, 80) && Near(MainButton(1).y, 106) && Near(MainButton(2).y, 132) && Near(MainButton(3).y, 184));
	CHECK(Near(MainButton(0).x, 40) && Near(MainButton(3).w, 100) && Near(MainButton(3).h, 20));
	CHECK(Near(kMotdWindow.x, 40) && Near(kMotdWindow.y, 240) && Near(kMotdWindow.w, 362) && Near(kMotdWindow.h, 220));
	CHECK(Near(MotdScroll().x, 56) && Near(MotdScroll().y, 256) && Near(MotdScroll().w, 330) && Near(MotdScroll().h, 204));
	CHECK(Near(kPartsWindow.x, kMotdWindow.x + kMotdWindow.w)); // the Inventory begins where the MOTD box ends
	CHECK(Near(PartsInfoY(), 146.667f));
	CHECK(Near(PartsBarH(), 86.667f));
	CHECK(Near(PartsBar(0).x, 35) && Near(PartsBar(1).x, 90) && Near(PartsBar(2).x, 145) && Near(PartsBar(2).w, 20) && Near(PartsBar(1).y, 50));
	CHECK(Near(PartsBarLabel(0).x, 25) && Near(PartsBarLabel(2).x, 135) && Near(PartsBarLabel(1).y, PartsInfoY()));
	// the bars and labels lie inside the Inventory panel
	CHECK(PartsBar(2).x + PartsBar(2).w <= kPartsWindow.w && PartsBar(0).y + PartsBar(0).h <= kPartsWindow.h);
	CHECK(Near(kMoneyLabel.x, 550) && Near(kMoneyLabel.y, 80) && Near(kMapInfo.x, 550) && Near(kMapInfo.y, 100) && Near(kMapInfo.w, 80));
	// everything is on the 640 x 480 screen
	CHECK(kMotdWindow.x + kMotdWindow.w <= 640 && kMotdWindow.y + kMotdWindow.h <= 480);
	CHECK(kPartsWindow.x + kPartsWindow.w <= 640 && kPartsWindow.y + kPartsWindow.h <= 480);

	// the car menu: makes at x 20, models at x 124, pitch 26; four rows for the make with four models; Cancel under them, Spectate under that
	CHECK(ModelSlots() == 4);
	CHECK(Near(CarMakeButton(0).x, 20) && Near(CarMakeButton(2).y, 110 + 52));
	CHECK(Near(CarModelButton(0).x, 124) && Near(CarModelButton(3).y, 110 + 78));
	CHECK(Near(CarCancelButton().y, 110 + 26 * 4) && Near(CarSpectateButton().y, 110 + 26 * 5));
	CHECK(CarSpectateButton().y + CarSpectateButton().h <= kCarModelWindow.y + 5); // it may touch the window's top by a few units, as HL Rally's does
	CHECK(Near(kCarStatWindow.x, 230) && Near(kCarStatWindow.y, 80) && Near(kCarStatWindow.w, 374) && Near(kCarStatWindow.h, 176));
	CHECK(Near(kCarStatRow0, 86) && Near(kCarStatPitch, 20) && Near(kCarStatBarX, 260) && Near(kCarStatLabelX, 176));
	CHECK(Near(kCarModelWindow.x, 124) && Near(kCarModelWindow.y, 256) && Near(kCarModelWindow.h, 216));
	CHECK(kCarModelWindow.x + kCarModelWindow.w <= 640 && kCarModelWindow.y + kCarModelWindow.h <= 480);
	// the stat rows fit the window
	CHECK(kCarStatRow0 + 2 * kCarStatPitch + kCarStatBarH <= kCarStatWindow.h);

	// Customise: classes at x 40, pitch 28; parts panel at (124, 110); Cancel under the fourth row; the info window and its two lines
	CHECK(Near(CustClassButton(0).x, 40) && Near(CustClassButton(3).y, 110 + 84) && Near(CustClassButton(1).w, 110));
	CHECK(Near(kCustPartsPanel.x, 124) && Near(kCustPartsPanel.y, 110));
	CHECK(Near(CustPartButton(2).y, 56) && Near(CustCancelButton().y, 112));
	CHECK(CustCancelButton().y + CustCancelButton().h <= kCustPartsPanel.h);
	CHECK(Near(CustInfoText().x, 16) && Near(CustInfoText().y, 46) && Near(CustInfoText().w, 342) && Near(CustInfoText().h, 94));
	CHECK(Near(kCustEffect.x, 250) && Near(kCustEffect.y, 140) && Near(kCustCost.y, 160));
	CHECK(Near(kCustPorthole.x, 160) && Near(kCustPorthole.y, 275) && Near(kCustPorthole.w, 340) && Near(kCustPorthole.h, 180));
	CHECK(kCustPorthole.x + kCustPorthole.w <= 640 && kCustPorthole.y + kCustPorthole.h <= 480);

	// the showroom's numbers
	CHECK(Near(kShowFwd, 65) && Near(kShowRight, 9) && Near(kShowUp, -23) && Near(kShowLightRadius, 70));
	CHECK(kShowLightR == 120 && kShowLightG == 120 && kShowLightB == 130);

	// Customise and Race wait for a car
	CHECK(MainButtonShown(0, false) && MainButtonShown(2, false) && !MainButtonShown(1, false) && !MainButtonShown(3, false));
	CHECK(MainButtonShown(1, true) && MainButtonShown(3, true));
}

static void TestQueue()
{
	Session s;
	CHECK(!s.HasPick() && s.PickedCar() == 0 && s.ShownMoney() == 0);
	s.SetMoney(600);
	CHECK(s.ShownMoney() == 600);
	s.SetMoney(-5);
	CHECK(s.ShownMoney() == 0);
	s.SetMoney(600);

	// a pick: the buttons come, the car is the one picked, and a free car costs nothing
	CHECK(s.Pick(4) && s.HasPick() && s.PickedCar() == 4 && s.ShownMoney() == 600);
	CHECK(!s.Pick(0) && !s.Pick(11)); // no such class
	int stat[3], total[3];
	s.Bars(stat, total);
	CHECK(stat[0] == 90 && stat[1] == 80 && stat[2] == 70 && total[0] == 90 && total[1] == 80 && total[2] == 70);

	// the first purchase: 300 for tyres of +3 handling. The figure shown drops at once; a price above the figure is refused ("Insufficient Funds")
	CHECK(s.Buy(0) == Session::BUY_OK && s.ShownMoney() == 300);
	s.Bars(stat, total);
	CHECK(total[1] == 83 && stat[1] == 80); // the green is the stat, the red reaches 83
	CHECK(s.Buy(1) == Session::BUY_NO_FUNDS && s.ShownMoney() == 300); // 500 against 300: refused, nothing queued
	CHECK(s.Buy(3) == Session::BUY_OK && s.ShownMoney() == 100); // 200: a mid pipe, top speed +4
	CHECK(s.Buy(3) == Session::BUY_NO_FUNDS && s.ShownMoney() == 100); // 200 against 100
	CHECK(s.Buy(-1) == Session::BUY_BAD && s.Buy(10) == Session::BUY_BAD);
	s.Bars(stat, total);
	CHECK(total[2] == 74);
	{
		// the figure may be spent to nothing: only a price above it refuses
		Session z;
		z.SetMoney(200);
		z.Pick(1);
		CHECK(z.Buy(3) == Session::BUY_OK && z.ShownMoney() == 0 && z.Buy(3) == Session::BUY_NO_FUNDS);
	}

	// Race: the car is the car in use (none: the server never said), so it is sent; the buys follow
	char out[160];
	int n = s.Execute(false, out, sizeof(out));
	CHECK(n > 0 && strcmp(out, "changecar 4;buy 0;buy 3;") == 0);
	CHECK(s.remembered == 4 && s.serverCar == 4 && s.nev == 1 && s.HasPick()); // the car stays queued: Customise and Race still show
	CHECK(s.ShownMoney() == 100 && s.money == 100); // 600 less 300 and 200
	CHECK((s.owned & 1u) && (s.owned & (1u << 3)) && !(s.owned & (1u << 4))); // tyres 0 and exhaust 3 are held
	// pressing Race again with nothing new: the same car, not a spectator: nothing is sent (a car is not respawned)
	n = s.Execute(false, out, sizeof(out));
	CHECK(n == 0 && out[0] == 0);
	// as a spectator the car is sent again
	n = s.Execute(true, out, sizeof(out));
	CHECK(strcmp(out, "changecar 4;") == 0);

	// a purchase in the middle of a race: the car in use is the car picked, so it is left out
	Session m;
	m.SetCar(5);
	m.SetMoney(7000);
	CHECK(m.HasPick() && m.PickedCar() == 5); // the server gave a car: Customise shows
	CHECK(m.Pick(5) && m.Buy(8) == Session::BUY_OK);
	n = m.Execute(false, out, sizeof(out));
	CHECK(strcmp(out, "buy 8;") == 0);
	CHECK(m.money == 7000 - 4500);

	// another car: it is sent and remembered
	CHECK(m.Pick(6));
	n = m.Execute(false, out, sizeof(out));
	CHECK(strcmp(out, "changecar 6;") == 0 && m.remembered == 6);

	// the server speaks last
	m.SetMoney(1234);
	m.SetParts(1u << 2);
	m.SetCar(3);
	CHECK(m.money == 1234 && m.owned == (1u << 2) && m.serverCar == 3 && m.remembered == 3);
	m.SetParts(0xFFFFFFFFu);
	CHECK(m.owned == (1u << H9R_NUM_PARTS) - 1u); // only the table's bits
	m.SetCar(99);
	CHECK(m.serverCar == 0);

	// a car picked twice is queued once; the purchases stay
	Session g;
	g.SetMoney(7000);
	g.Pick(2);
	g.Buy(0);
	g.Pick(3);
	CHECK(g.nev == 2 && g.PickedCar() == 3 && g.ev[0].kind == EV_BUY && g.ev[1].kind == EV_CAR);

	// the queue is bounded
	Session f;
	f.SetMoney(7000);
	f.Pick(1);
	int bought = 0;
	while (f.Buy(0) == Session::BUY_OK)
		bought++;
	CHECK(bought == kMaxEvents - 1 && f.Buy(0) == Session::BUY_FULL);
}

static void TestUpgrades()
{
	// parts held (from the server) show red; a different car clears them as the server will; a purchase after the change adds
	Session s;
	s.SetCar(4);
	s.SetMoney(7000);
	s.SetParts(1u << 2); // gravel tyres: handling +7
	int add[3], stat[3], total[3];
	s.Added(add);
	CHECK(add[0] == 0 && add[1] == 7 && add[2] == 0);
	s.Bars(stat, total);
	CHECK(stat[1] == 80 && total[1] == 87);
	CHECK(s.Pick(4)); // the same car: nothing lost
	s.Added(add);
	CHECK(add[1] == 7);
	CHECK(s.Pick(5)); // another: the parts go
	s.Added(add);
	CHECK(add[0] == 0 && add[1] == 0 && add[2] == 0);
	CHECK(s.Buy(0) == Session::BUY_OK); // +3 on the new car
	s.Added(add);
	CHECK(add[1] == 3);
	s.Bars(stat, total);
	CHECK(stat[1] == 85 && total[1] == 88); // car 5: 85/85/70

	// one part to a class: tyres 0 then 1: the later
	Session t;
	t.SetMoney(7000);
	t.Pick(1);
	t.Buy(0);
	t.Buy(1);
	t.Added(add);
	CHECK(add[1] == 5);
	// all four classes: tyres 7, exhaust 8, intercooler 8, single turbo 15 + 15
	Session u;
	u.money = 20000; // beyond the real cap, only to buy them all here
	u.Pick(1);
	CHECK(u.Buy(2) == Session::BUY_OK && u.Buy(5) == Session::BUY_OK && u.Buy(7) == Session::BUY_OK && u.Buy(8) == Session::BUY_OK);
	u.Added(add);
	CHECK(add[0] == 8 + 15 && add[1] == 7 && add[2] == 8 + 15);
	u.Bars(stat, total);
	CHECK(stat[0] == 80 && total[0] == 100 && total[1] == 87 && total[2] == 100); // 80 + 23 is cut at the bar's top
}

static void TestShowroom()
{
	const float org[3] = {100, 200, 50};
	float out[3];
	const float a0[3] = {0, 0, 0};
	ShowPlace(a0, a0, out); // from the origin looking along x: 65 ahead, 9 to the right (-y), 23 down
	CHECK(Near(out[0], 65) && Near(out[1], -9) && Near(out[2], -23));
	const float a90[3] = {0, 90, 0};
	ShowPlace(org, a90, out); // looking along y: ahead is +y, right is +x
	CHECK(Near(out[0], 109) && Near(out[1], 265) && Near(out[2], 27));
	const float aUp[3] = {-90, 0, 0}; // looking straight up: ahead is +z, "up" is -x
	ShowPlace(a0, aUp, out);
	CHECK(Near(out[2], 65) && Near(out[1], -9) && Near(fabsf(out[0]), 23));

	// the vectors are orthonormal
	float f[3], r[3], u[3];
	const float ang[3] = {20, 130, 15};
	Vectors(ang, f, r, u);
	CHECK(Near(f[0] * f[0] + f[1] * f[1] + f[2] * f[2], 1, 0.001f) && Near(f[0] * r[0] + f[1] * r[1] + f[2] * r[2], 0, 0.001f) && Near(r[0] * u[0] + r[1] * u[1] + r[2] * u[2], 0, 0.001f));

	// the livery by class, the eight of the car model
	CHECK(ShowSkin(1) == 0 && ShowSkin(8) == 7 && ShowSkin(9) == 0 && ShowSkin(10) == 1 && ShowSkin(0) == 0);

	// the spin: one degree a frame at 99 frames a second, the same in a second at any rate
	Spin a, b, c;
	for (int i = 0; i < 99; i++)
		SpinFrame(a, 1.0f / 99.0f);
	CHECK(Near(a.yaw, WrapYaw(kShowStartYaw + 99), 0.05f));
	for (int i = 0; i < 30; i++)
		SpinFrame(b, 1.0f / 30.0f);
	for (int i = 0; i < 200; i++)
		SpinFrame(c, 1.0f / 200.0f);
	CHECK(Near(b.yaw, a.yaw, 0.1f) && Near(c.yaw, a.yaw, 0.1f));
	Spin held;
	held.down = true;
	SpinFrame(held, 1.0f);
	CHECK(Near(held.yaw, kShowStartYaw)); // the mouse holds it
	Spin hitch;
	SpinFrame(hitch, 5.0f); // a long stall turns it by the cap, not five seconds' worth
	CHECK(Near(hitch.yaw, WrapYaw(kShowStartYaw + 9.9f), 0.05f));
	Spin w;
	w.yaw = 179.5f;
	SpinFrame(w, 1.0f / 99.0f);
	CHECK(w.yaw > -180.0f && w.yaw < -178.0f); // wraps

	// the drag: the left button adds both axes, the right takes them; the spin goes on the way it was dragged
	Spin d;
	d.yaw = 0;
	DragMove(d, 1, 3, 2);
	CHECK(Near(d.yaw, 5) && d.dir == 1);
	DragMove(d, 1, -10, 0);
	CHECK(Near(d.yaw, -5) && d.dir == -1);
	DragMove(d, 2, 4, 0);
	CHECK(Near(d.yaw, -9) && d.dir == -1);
	DragMove(d, 2, -6, -1);
	CHECK(Near(d.yaw, -2) && d.dir == 1);
	DragMove(d, 3, 100, 100); // no such button
	CHECK(Near(d.yaw, -2));
	DragMove(d, 1, 0, 0);
	CHECK(d.dir == 1 && Near(d.yaw, -2)); // no motion: no change of way
	Spin e;
	e.yaw = 179;
	DragMove(e, 1, 5, 0);
	CHECK(Near(e.yaw, -176)); // wrapped

	// the shadow: 26 long and 12 wide on the car's origin, turned by its yaw
	float sh[4][3];
	const float p[3] = {10, 20, 30};
	ShadowCorners(p, 0, sh);
	CHECK(Near(sh[0][0], 36) && Near(sh[0][1], 32) && Near(sh[1][0], -16) && Near(sh[0][2], 30));
	CHECK(Near(sh[2][0], -16) && Near(sh[2][1], 8) && Near(sh[3][0], 36) && Near(sh[3][1], 8));
	ShadowCorners(p, 90, sh);
	CHECK(Near(sh[0][0], -2) && Near(sh[0][1], 46)); // forward is now +y, right +x: FL = org + f*26 - r*12

	// the black room: back wall 110 ahead from -100 (right) to +50 (left) across and 80 up and down; the window 5 ahead is 10 by 8; the floor 40..110 ahead
	float room[5][4][3];
	const float o0[3] = {0, 0, 0}, ang0[3] = {0, 0, 0};
	RoomQuads(o0, ang0, room); // looking along x: right is -y, up is +z
	CHECK(Near(room[0][0][0], 110) && Near(room[0][0][1], -100) && Near(room[0][0][2], 80)); // far top right
	CHECK(Near(room[0][1][1], 50) && Near(room[0][2][2], -80) && Near(room[0][3][1], -100)); // far left is +50 (half), far bottom is -80
	CHECK(Near(room[1][1][0], 5) && Near(room[1][1][1], -5) && Near(room[1][1][2], 4));      // the right side starts at the window's top right
	CHECK(Near(room[4][1][0], 5) && Near(room[4][1][1], 5) && Near(room[4][1][2], -4));      // the bottom side: near bottom left
	for (int q = 0; q < 5; q++)
		for (int v = 0; v < 4; v++)
			CHECK(room[q][v][0] >= 5 - 0.01f && room[q][v][0] <= 110 + 0.01f);               // nothing behind the window or past the wall
	float fl[4][3];
	FloorQuad(o0, ang0, fl);
	CHECK(Near(fl[0][0], 40) && Near(fl[0][1], 30) && Near(fl[0][2], -32) && Near(fl[1][1], -50)); // front left is +y when looking along x
	CHECK(Near(fl[2][0], 110) && Near(fl[2][2], -16) && Near(fl[3][1], 30));
	// the car's origin (65 ahead, 9 right, 23 down) stands on the floor's footprint and just above it
	float car[3];
	ShowPlace(o0, ang0, car);
	const float t = (car[0] - 40) / 70, floorZ = -32 + 16 * t;
	CHECK(car[1] < fl[0][1] && car[1] > fl[1][1] && car[2] > floorZ && car[2] - floorZ < 6);
	// the camera is set for every ordinary frame (the spectator's too) and only while a menu is up, not in intermission nor in the mirror's pass
	CHECK(CameraApplies(true, 0, 0) && !CameraApplies(false, 0, 0) && !CameraApplies(true, 1, 0) && !CameraApplies(true, 0, 1));
}

static void TestMapInfo()
{
	char path[64];
	CHECK(MapInfoPath("maps/rc_wintervalley.bsp", path, sizeof(path)) && strcmp(path, "maps/rc_wintervalley_mapinfo.txt") == 0);
	CHECK(!MapInfoPath(nullptr, path, sizeof(path)) && path[0] == 0);
	CHECK(!MapInfoPath("a", path, sizeof(path)) && !MapInfoPath("maps/x.bsp", path, 8)); // too short a name, too small a buffer
	CHECK(strcmp(kMapInfoDefault, "maps/default_mapinfo.txt") == 0);
}

static void TestKeys()
{
	const char* files[2] = {"rally.txt", "rally_wasd.txt"};
	for (int i = 0; i < 2; i++)
	{
		char* t = ReadFile(files[i]);
		CHECK(t != nullptr);
		if (!t)
			continue;
		// a line `"m" "selectcar"` (HL Rally's own key), and no other use of m
		bool have = false;
		int mLines = 0;
		for (char* line = t; line && *line;)
		{
			char* nl = strchr(line, '\n');
			if (nl)
				*nl = 0;
			if (strncmp(line, "\"m\"", 3) == 0)
			{
				mLines++;
				have = have || strstr(line, "\"selectcar\"") != nullptr;
			}
			line = nl ? nl + 1 : nullptr;
		}
		CHECK(have && mLines == 1);
		free(t);
	}
}

int main()
{
	TestCars();
	TestParts();
	TestLayout();
	TestQueue();
	TestUpgrades();
	TestShowroom();
	TestMapInfo();
	TestKeys();
	printf("carmenu_test: %d checks, %d failed\n", g_checked, g_failed);
	printf("%s\n", g_failed == 0 ? "PASS" : "FAIL");
	return g_failed == 0 ? 0 : 1;
}
