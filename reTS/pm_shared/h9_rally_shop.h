/***
*  h9_rally_shop.h -- rally mode's car menu and shop: the data the server and the client share, and the contract between them.
*
*  HL Rally (read for behaviour and numbers only, no code or text copied): its main menu (Select Car, Customise, Spectate, Race),
*  the car menu (make, then model; three stat bars), the Customise shop (four classes of parts, costs and effects from its
*  customise.txt), money ($600 at join, cap $7000, +20 a checkpoint, +100 to the first car through one, 800/600/400/200 for
*  places 1 to 4 and +600 to everybody at the finish). See C:/tmp/h9/parity/carselect.md.
*
*  Our own: the makes and model names (invented brands, no real-world trademarks), the parts' descriptions.
*
*  CONTRACT (client <-> server), rally mode only:
*    client -> server
*      changecar <class>      1..H9R_NUM_CARS: this car for me (HL Rally's changecar <model>); free.
*      spectate               out of the next race, observer (HL Rally's spectate).
*      selectcar              HL Rally's `m`: only while a race runs; out until the next race, and the server opens the menu.
*      buy <part>             0..H9R_NUM_PARTS-1: buy that part if the money allows and the class has no better one.
*    server -> client
*      H9RMoney  (4 bytes)    long: my money now (sent at join and at every change; HL Rally sent it only at join and finish,
*                             a lag we do not copy).
*      H9RParts  (4 bytes)    long: bit p set = part p owned (for the red segments of the bars and the shop's buttons).
*      H9RCar    (1 byte)     byte: my car class now (0 none chosen).
*      VGUIMenu               the stock message; MENU_INTRO in rally mode opens the rally main menu (at join, and after selectcar).
*    physinfo (set by the server, read by pm_shared)
*      "rally"  class 1..10 (exists); "rh" handling added by parts; "rt" top speed added by parts (ints, in stat %).
***/
#pragma once

// ---- the cars: display only; the handling numbers stay in h9_rally.h's g_h9RallyCars, same order (class = index + 1) ----
struct H9RallyCarShow
{
	const char* make;  // invented
	const char* model; // invented
};
static const H9RallyCarShow g_h9RallyCarShow[10] = {
	{"VOLKRA", "Strata"},     // 1  80/80/80
	{"AMBERLINE", "Dart"},    // 2  85/75/80
	{"VOLKRA", "Locus"},      // 3  80/90/70
	{"KESTREL", "R7"},        // 4  90/80/70
	{"AMBERLINE", "Twenty6"}, // 5  85/85/70
	{"KESTREL", "Octane"},    // 6  75/75/90
	{"KESTREL", "Faro"},      // 7  75/75/90
	{"VOLKRA", "Imperix"},    // 8  80/85/75
	{"AMBERLINE", "Celeste"}, // 9  80/75/85
	{"AMBERLINE", "Corsa"},   // 10 80/70/90
};

// ---- the shop: HL Rally's customise.txt numbers; a class holds one part at a time ----
enum H9RallyPartClass
{
	H9R_PC_TYRES = 0,
	H9R_PC_EXHAUST,
	H9R_PC_INTERCOOLER,
	H9R_PC_TURBO,
	H9R_NUM_PART_CLASSES
};
struct H9RallyPart
{
	int partClass;
	const char* name; // our own words
	int cost;         // $
	int accel;        // stat % added (Acceleration: read by nothing in the movement, as in HL Rally)
	int handling;     // stat % added
	int top;          // stat % added
};
#define H9R_NUM_PARTS 10
static const H9RallyPart g_h9RallyParts[H9R_NUM_PARTS] = {
	{H9R_PC_TYRES, "Street tyres", 300, 0, 3, 0},
	{H9R_PC_TYRES, "Sport tyres", 500, 0, 5, 0},
	{H9R_PC_TYRES, "Gravel tyres", 700, 0, 7, 0},
	{H9R_PC_EXHAUST, "Mid pipe", 200, 0, 0, 4},
	{H9R_PC_EXHAUST, "Cat-back", 550, 0, 0, 6},
	{H9R_PC_EXHAUST, "Turbo-back", 800, 0, 0, 8},
	{H9R_PC_INTERCOOLER, "Small core", 1500, 4, 0, 0},
	{H9R_PC_INTERCOOLER, "Large core", 3100, 8, 0, 0},
	{H9R_PC_TURBO, "Single turbo", 4500, 15, 0, 15},
	{H9R_PC_TURBO, "Twin turbo", 3200, 15, 0, 8},
};

// ---- money ----
#define H9R_MONEY_START 600
#define H9R_MONEY_CAP 7000
#define H9R_MONEY_CHECKPOINT 20
#define H9R_MONEY_FIRST_THROUGH 100
static const int g_h9RallyFinishPay[4] = {800, 600, 400, 200}; // places 1 to 4
#define H9R_MONEY_FINISH_ALL 600
