// Checks the race HUD's arithmetic (h9_racehud_draw.h: the clocks' text, the clock's offset, the start lights, the map's fit, the
// gauge) and its layout (nothing off the screen, no part over another, nothing in the middle of the screen while racing, little of
// the screen taken) with no game, and, given a folder, draws the HUD into PNG pictures there with the very Painter the game draws
// with, over a canvas that is a picture in memory (racehud-<scene>-<size>.png over a night, racehud-snow-<scene>-<size>.png over snow):
//   cmake --build <dir> --target racehud_test --config Release
//   racehud_test [<folder for the pictures> [<a .map with race_waypoint and race_checkpoint entities>]]
// With no map the pictures have a made-up oval for a lap.
#include "../h9_racehud_draw.h"
#include "../h9_rallyhud_draw.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

using namespace racehud;

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

static bool Same(const char* a, const char* b)
{
	return 0 == strcmp(a, b);
}

// ---- canvases ---------------------------------------------------------------------------------------------------------------------

// Keeps the box round everything drawn, and whether anything left the screen.
struct Bounds : Canvas
{
	int w, h;
	int x0, y0, x1, y1, count;
	bool outside;
	Bounds(int W, int H) : w(W), h(H), x0(W), y0(H), x1(0), y1(0), count(0), outside(false) {}
	void Fill(int x, int y, int fw, int fh, int, int, int, int) override
	{
		count++;
		if (x < 0 || y < 0 || x + fw > w || y + fh > h || fw <= 0 || fh <= 0)
			outside = true;
		x0 = x < x0 ? x : x0;
		y0 = y < y0 ? y : y0;
		x1 = x + fw > x1 ? x + fw : x1;
		y1 = y + fh > y1 ? y + fh : y1;
	}
	int Width() override { return w; }
	int Height() override { return h; }
	bool Empty() const { return count == 0; }
};

static bool Apart(const Bounds& a, const Bounds& b)
{
	if (a.Empty() || b.Empty())
		return true;
	return a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
}

// A picture in memory: what the game's screen would show, over a made-up night scene, or a snow one (white ground, a pale sky).
struct Picture : Canvas
{
	int w, h;
	std::vector<unsigned char> rgb;
	Picture(int W, int H, bool snow = false) : w(W), h(H), rgb((size_t)W * H * 3)
	{
		// a dark sky, a horizon glow, a grey road with a bright patch (a lit stretch) to judge the panels against
		for (int y = 0; y < h; y++)
		{
			for (int x = 0; x < w; x++)
			{
				const float fy = (float)y / h, fx = (float)x / w;
				int r = 18, g = 20, b = 34;
				if (fy > 0.45f)
				{
					const int road = 52 + (int)(40 * (fy - 0.45f));
					r = road;
					g = road;
					b = road + 6;
					if (fx > 0.3f && fx < 0.7f && fy > 0.6f)
						r = g = b = 150 + (int)(60 * fy);
				}
				else if (fy > 0.36f)
				{
					r = 90;
					g = 50;
					b = 120;
				}
				if (snow)
				{
					// a pale sky, grey rock on the horizon, white ground with a darker rut down the middle
					r = 196, g = 210, b = 228;
					if (fy > 0.45f)
					{
						r = g = 232 + (int)(20 * fy);
						b = 255;
						if (fx > 0.42f && fx < 0.58f && fy > 0.6f)
							r = g = b = 176;
					}
					else if (fy > 0.3f)
					{
						r = g = b = ((x / 37 + y / 23) % 2) ? 92 : 128;
					}
				}
				unsigned char* p = &rgb[((size_t)y * w + x) * 3];
				p[0] = (unsigned char)r;
				p[1] = (unsigned char)g;
				p[2] = (unsigned char)b;
			}
		}
	}
	void Fill(int x, int y, int fw, int fh, int r, int g, int b, int a) override
	{
		for (int yy = y < 0 ? 0 : y; yy < y + fh && yy < h; yy++)
		{
			for (int xx = x < 0 ? 0 : x; xx < x + fw && xx < w; xx++)
			{
				unsigned char* p = &rgb[((size_t)yy * w + xx) * 3];
				p[0] = (unsigned char)((p[0] * (255 - a) + r * a) / 255);
				p[1] = (unsigned char)((p[1] * (255 - a) + g * a) / 255);
				p[2] = (unsigned char)((p[2] * (255 - a) + b * a) / 255);
			}
		}
	}
	int Width() override { return w; }
	int Height() override { return h; }
};

// ---- a PNG with nothing packed ----------------------------------------------------------------------------------------------------

static unsigned int Crc(const unsigned char* data, size_t n, unsigned int crc)
{
	static unsigned int table[256];
	static bool made = false;
	if (!made)
	{
		for (unsigned int i = 0; i < 256; i++)
		{
			unsigned int c = i;
			for (int k = 0; k < 8; k++)
				c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
			table[i] = c;
		}
		made = true;
	}
	crc = ~crc;
	for (size_t i = 0; i < n; i++)
		crc = table[(crc ^ data[i]) & 255] ^ (crc >> 8);
	return ~crc;
}

static void Put32(std::vector<unsigned char>& out, unsigned int v)
{
	out.push_back((unsigned char)(v >> 24));
	out.push_back((unsigned char)(v >> 16));
	out.push_back((unsigned char)(v >> 8));
	out.push_back((unsigned char)v);
}

static void Chunk(std::vector<unsigned char>& out, const char* type, const std::vector<unsigned char>& data)
{
	Put32(out, (unsigned int)data.size());
	std::vector<unsigned char> body(type, type + 4);
	body.insert(body.end(), data.begin(), data.end());
	out.insert(out.end(), body.begin(), body.end());
	Put32(out, Crc(body.data(), body.size(), 0));
}

static bool WritePng(const std::string& path, const Picture& pic)
{
	std::vector<unsigned char> raw;
	raw.reserve((size_t)pic.h * (pic.w * 3 + 1));
	for (int y = 0; y < pic.h; y++)
	{
		raw.push_back(0);
		raw.insert(raw.end(), pic.rgb.begin() + (size_t)y * pic.w * 3, pic.rgb.begin() + (size_t)(y + 1) * pic.w * 3);
	}
	std::vector<unsigned char> z;
	z.push_back(0x78);
	z.push_back(0x01);
	unsigned int a = 1, b = 0;
	for (size_t at = 0; at < raw.size();)
	{
		const size_t n = raw.size() - at < 65535 ? raw.size() - at : 65535;
		z.push_back(at + n >= raw.size() ? 1 : 0);
		z.push_back((unsigned char)(n & 255));
		z.push_back((unsigned char)(n >> 8));
		z.push_back((unsigned char)(~n & 255));
		z.push_back((unsigned char)((~n >> 8) & 255));
		for (size_t i = 0; i < n; i++)
		{
			a = (a + raw[at + i]) % 65521;
			b = (b + a) % 65521;
		}
		z.insert(z.end(), raw.begin() + at, raw.begin() + at + n);
		at += n;
	}
	Put32(z, (b << 16) | a);

	std::vector<unsigned char> out = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
	std::vector<unsigned char> head;
	Put32(head, (unsigned int)pic.w);
	Put32(head, (unsigned int)pic.h);
	head.push_back(8);
	head.push_back(2);
	head.push_back(0);
	head.push_back(0);
	head.push_back(0);
	Chunk(out, "IHDR", head);
	Chunk(out, "IDAT", z);
	Chunk(out, "IEND", std::vector<unsigned char>());
	FILE* f = fopen(path.c_str(), "wb");
	if (!f)
		return false;
	fwrite(out.data(), 1, out.size(), f);
	fclose(f);
	return true;
}

// ---- the lap's line ---------------------------------------------------------------------------------------------------------------

struct MapData
{
	std::vector<Pt> line;
	std::vector<Pt> cps;
};

static short Coord(double v)
{
	return (short)floor(v / RACE_HUD_COORD + 0.5);
}

// The race_waypoints by number and the race_checkpoints' middles (the middle of their brushes' points) by number.
static bool LoadMap(const char* path, MapData& out)
{
	FILE* f = fopen(path, "rb");
	if (!f)
		return false;
	struct Ent
	{
		std::string cls;
		double x = 0, y = 0;
		int number = -1;
		bool hasOrigin = false;
		double minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
	};
	std::vector<Ent> way, cp;
	Ent cur;
	int depth = 0;
	char line[1024];
	while (fgets(line, sizeof(line), f))
	{
		if (line[0] == '{')
		{
			if (depth == 0)
				cur = Ent();
			depth++;
		}
		else if (line[0] == '}')
		{
			depth--;
			if (depth == 0)
			{
				if (cur.cls == "race_waypoint" && cur.hasOrigin)
					way.push_back(cur);
				if (cur.cls == "race_checkpoint")
					cp.push_back(cur);
			}
		}
		else if (depth == 1 && line[0] == '"')
		{
			char key[64], value[256];
			if (2 == sscanf(line, "\"%63[^\"]\" \"%255[^\"]\"", key, value))
			{
				if (Same(key, "classname"))
					cur.cls = value;
				else if (Same(key, "number"))
					cur.number = atoi(value);
				else if (Same(key, "origin"))
					cur.hasOrigin = 2 <= sscanf(value, "%lf %lf", &cur.x, &cur.y);
			}
		}
		else if (depth == 2 && line[0] == '(')
		{
			double p[9];
			if (9 == sscanf(line, "( %lf %lf %lf ) ( %lf %lf %lf ) ( %lf %lf %lf )", &p[0], &p[1], &p[2], &p[3], &p[4], &p[5], &p[6], &p[7], &p[8]))
			{
				for (int i = 0; i < 9; i += 3)
				{
					cur.minX = p[i] < cur.minX ? p[i] : cur.minX;
					cur.maxX = p[i] > cur.maxX ? p[i] : cur.maxX;
					cur.minY = p[i + 1] < cur.minY ? p[i + 1] : cur.minY;
					cur.maxY = p[i + 1] > cur.maxY ? p[i + 1] : cur.maxY;
				}
			}
		}
	}
	fclose(f);
	for (int number = 0;; number++)
	{
		bool found = false;
		for (const Ent& e : way)
			if (e.number == number)
			{
				Pt p = {Coord(e.x), Coord(e.y)};
				out.line.push_back(p);
				found = true;
				break;
			}
		if (!found)
			break;
	}
	for (int number = 0;; number++)
	{
		bool found = false;
		for (const Ent& e : cp)
			if (e.number == number)
			{
				Pt p = {Coord((e.minX + e.maxX) / 2), Coord((e.minY + e.maxY) / 2)};
				out.cps.push_back(p);
				found = true;
				break;
			}
		if (!found)
			break;
	}
	return out.line.size() >= 3;
}

static void Oval(MapData& out)
{
	for (int i = 0; i < 60; i++)
	{
		const double a = i * 6.2831853 / 60;
		Pt p = {Coord(5000 * cos(a) + 600 * cos(3 * a)), Coord(3200 * sin(a))};
		out.line.push_back(p);
	}
	for (int i = 0; i < 6; i++)
		out.cps.push_back(out.line[i * 10]);
}

// ---- scenes -----------------------------------------------------------------------------------------------------------------------

static const char* const kNames[] = {"Deoroot", "xX_DriftKing_Xx", "Lena", "marek.cz", "A Very Long Player Name Indeed", "bot_07", "Nikos", "Q"};

static void BaseModel(Model& m, const MapData& map, float now)
{
	m.haveState = true;
	m.state = RACE_RACING;
	m.laps = 3;
	m.racers = 8;
	m.countdown = 5;
	m.t0 = now - 83.45f;
	m.haveStat = true;
	m.statAt = now - 0.05f;
	m.lap = 2;
	m.place = 3;
	m.speed = 1030;
	m.gauge = 1030;
	m.slip = 0.05f;
	m.topSpeed = 1200;
	m.raceStart = now - 83.456f;
	m.lapStart = now - 41.203f;
	m.bestCs = 4211;
	m.local = 3;
	m.linePoints = m.lineTotal = (int)map.line.size() < MAX_LINE ? (int)map.line.size() : MAX_LINE;
	for (int i = 0; i < m.linePoints; i++)
		m.line[i] = map.line[i];
	m.cpPoints = m.cpTotal = (int)map.cps.size() < MAX_CPS ? (int)map.cps.size() : MAX_CPS;
	for (int i = 0; i < m.cpPoints; i++)
		m.cps[i] = map.cps[i];
	m.haveDots = true;
	m.dotsAt = now - 0.1f;
	m.dotCount = 8;
	static const int places[8] = {4, 1, 3, 2, 5, 6, 7, 8};
	for (int i = 0; i < 8; i++)
	{
		Dot& d = m.dots[i];
		d.index = i + 1;
		d.place = places[i];
		d.finished = d.retired = false;
		// spread along the line, the first furthest
		const int at = (m.linePoints * 6 / 10 - (d.place - 1) * (m.linePoints / 14) + m.linePoints) % m.linePoints;
		d.x = m.line[at].x;
		d.y = m.line[at].y;
		d.gap = d.place == 1 ? 0 : (d.place - 1) * 730;
		snprintf(d.name, sizeof(d.name), "%s", kNames[i]);
	}
}

static void Results(Model& m, float now)
{
	m.state = RACE_FINISHED;
	m.resultsUp = true;
	m.rowLaps = 3;
	m.rowCount = m.rowTotal = 8;
	m.rowsAt = now - 2;
	static const int order[8] = {2, 4, 3, 1, 5, 6, 7, 8};
	for (int i = 0; i < 8; i++)
	{
		Row& r = m.rows[i];
		r.place = i + 1;
		r.index = order[i];
		r.flags = i < 5 ? RACE_RF_FINISHED : (i == 6 ? RACE_RF_RETIRED : 0);
		r.lap = i < 5 ? 3 : 2;
		r.total = i < 5 ? 12734 + i * 311 : 0;
		r.best = i == 7 ? 0 : 4105 + i * 57;
		snprintf(r.name, sizeof(r.name), "%s", kNames[order[i] - 1]);
	}
}

// The scene by its name.
static void Scene(const char* name, Model& m, const MapData& map, float now)
{
	BaseModel(m, map, now);
	if (Same(name, "racing"))
	{
		m.noteKind = RACE_NOTE_CHECKPOINT;
		m.noteA = 3;
		m.noteB = 7;
		m.noteFlags = RACE_NF_DIFF;
		m.noteTime = 2317;
		m.noteDiff = -42;
		m.noteAt = now - 1;
	}
	else if (Same(name, "warmup"))
	{
		m.state = RACE_WAITING;
		m.t0 = now + 6.4f;
		m.speed = m.gauge = 340;
		for (int i = 0; i < m.dotCount; i++)
			m.dots[i].place = 0, m.dots[i].gap = -1;
	}
	else if (Same(name, "countdown"))
	{
		m.state = RACE_COUNTDOWN;
		m.t0 = now + 2.6f;
		m.speed = m.gauge = 0;
	}
	else if (Same(name, "go"))
	{
		m.t0 = m.raceStart = m.lapStart = now - 0.6f;
		m.lap = 1;
		m.bestCs = 0;
		m.speed = m.gauge = 240;
	}
	else if (Same(name, "wrongway"))
	{
		m.flags = RACE_SF_WRONGWAY;
		m.slip = 0.85f;
		m.speed = m.gauge = -260;
		m.limitEnd = now + 7.3f;
		m.place = 1;
		m.noteKind = RACE_NOTE_LAP;
		m.noteA = 1;
		m.noteB = 3;
		m.noteFlags = RACE_NF_DIFF;
		m.noteTime = 4391;
		m.noteDiff = 180;
		m.noteAt = now - 1;
	}
	else if (Same(name, "finish"))
	{
		m.state = RACE_FINISHED;
		m.t0 = now + 21;
		m.flags = RACE_SF_FINISHED;
		m.place = 1;
		m.lap = 3;
		m.totalCs = 12734;
		m.speed = m.gauge = 80;
		m.slip = 0.4f;
		m.noteKind = RACE_NOTE_FINISH;
		m.noteA = 1;
		m.noteB = 8;
		m.noteTime = 12734;
		m.noteAt = now - 1;
		m.dots[1].finished = true;
	}
	else if (Same(name, "ending"))
	{
		m.state = RACE_FINISHED;
		m.t0 = now + 21.5f;
		m.lap = 3;
		m.place = 12;
		m.racers = 16;
		m.laps = 12;
		m.lap = 11;
		m.limitEnd = now + 95;
		m.noteKind = RACE_NOTE_LAP;
		m.noteA = 10;
		m.noteB = 12;
		m.noteFlags = RACE_NF_DIFF | RACE_NF_BEST;
		m.noteTime = 4105;
		m.noteDiff = -106;
		m.noteAt = now - 1;
		m.dots[1].finished = true;
		m.dots[7].retired = true;
	}
	else if (Same(name, "results"))
		Results(m, now);
}

static const char* const kScenes[] = {"racing", "warmup", "countdown", "go", "wrongway", "finish", "ending", "results"};

// ---- the checks -------------------------------------------------------------------------------------------------------------------

static void CheckText()
{
	char t[32];
	FormatTime(t, sizeof(t), 0);
	CHECK(Same(t, "0:00.00"));
	FormatTime(t, sizeof(t), 8345);
	CHECK(Same(t, "1:23.45"));
	FormatTime(t, sizeof(t), 5999);
	CHECK(Same(t, "0:59.99"));
	FormatTime(t, sizeof(t), 6000);
	CHECK(Same(t, "1:00.00"));
	FormatTime(t, sizeof(t), 360007);
	CHECK(Same(t, "60:00.07"));
	FormatTime(t, sizeof(t), -5);
	CHECK(Same(t, "0:00.00"));
	FormatDiff(t, sizeof(t), 42);
	CHECK(Same(t, "+0.42"));
	FormatDiff(t, sizeof(t), -120);
	CHECK(Same(t, "-1.20"));
	FormatDiff(t, sizeof(t), 0);
	CHECK(Same(t, "+0.00"));
	FormatDiff(t, sizeof(t), 6150);
	CHECK(Same(t, "+1:01.50"));
	CHECK(RunningCs(100.0f, 58.5f) == 4150);
	CHECK(RunningCs(10.0f, 10.2f) == 0); // a start that is still to come
	CHECK(RunningCs(12.349f, 10.0f) == 234); // what has passed: not rounded up
	Ordinal(t, sizeof(t), 1);
	CHECK(Same(t, "1ST"));
	Ordinal(t, sizeof(t), 2);
	CHECK(Same(t, "2ND"));
	Ordinal(t, sizeof(t), 3);
	CHECK(Same(t, "3RD"));
	Ordinal(t, sizeof(t), 11);
	CHECK(Same(t, "11TH"));
	Ordinal(t, sizeof(t), 12);
	CHECK(Same(t, "12TH"));
	Ordinal(t, sizeof(t), 22);
	CHECK(Same(t, "22ND"));
	CHECK(SpeedShown(1200) == 190);
	CHECK(SpeedShown(-1200) == 190);
	CHECK(SpeedShown(0) == 0);
	// rally mode: HL Rally's |velocity| / 3, 0 under 9: the road's top speed 680 reads 227, 26 u/s (8.7) reads 0, 27 reads 9
	CHECK(SpeedShown(680, RALLY_SPEED_UNITS, RALLY_SPEED_FLOOR) == 227);
	CHECK(SpeedShown(-680, RALLY_SPEED_UNITS, RALLY_SPEED_FLOOR) == 227);
	CHECK(SpeedShown(26, RALLY_SPEED_UNITS, RALLY_SPEED_FLOOR) == 0);
	CHECK(SpeedShown(27, RALLY_SPEED_UNITS, RALLY_SPEED_FLOOR) == 9);
	CHECK(SpeedShown(1200) == 190); // the h9_car's reading is unchanged
	CHECK(TextW("", 2) == 0);
	CHECK(TextW("A", 2) == 10);
	CHECK(TextW("AB", 3) == 33);
	CHECK(SegW("8", 10, 2) == 10);
	CHECK(SegW("1:23.45", 6, 2) == 5 * 6 + 2 * 2 + 6 * 3);
	// the font: a small letter is its capital; a character it does not have is '?'
	CHECK(0 == memcmp(Glyph('a'), Glyph('A'), 7));
	CHECK(0 == memcmp(Glyph('~'), Glyph('?'), 7));
	CHECK(0 == memcmp(Glyph((char)0xE9), Glyph('?'), 7));
	CHECK(0 != memcmp(Glyph('0'), Glyph('O'), 7));
}

static void CheckClock()
{
	// the one clock, the client a tenth behind: nothing added
	CHECK(ClockOffset(false, 0, 100.1f, 100.0f) == 0);
	CHECK(ClockOffset(true, 0, 100.0f, 100.9f) == 0);
	// another clock: the difference, at once
	CHECK(fabsf(ClockOffset(false, 0, 500.0f, 100.0f) - 400.0f) < 0.001f);
	// then followed gently: a message 0.2 s late moves it by a tenth of that
	CHECK(fabsf(ClockOffset(true, 400.0f, 499.8f, 100.0f) - 399.98f) < 0.001f);
	// a jump (a new map on the server's side): taken at once
	CHECK(fabsf(ClockOffset(true, 400.0f, 130.0f, 100.0f) - 30.0f) < 0.001f);
	// and back to the one clock
	CHECK(ClockOffset(true, 400.0f, 100.05f, 100.0f) == 0);
}

static void CheckLamps()
{
	Lamps l = LampState(RACE_COUNTDOWN, 5.0f, 5.0f, -5.0f);
	CHECK(l.show && l.reds == 1 && !l.green && l.number == 5);
	l = LampState(RACE_COUNTDOWN, 4.01f, 5.0f, -4.01f);
	CHECK(l.reds == 1 && l.number == 5);
	l = LampState(RACE_COUNTDOWN, 3.99f, 5.0f, -3.99f);
	CHECK(l.reds == 2 && l.number == 4);
	l = LampState(RACE_COUNTDOWN, 2.5f, 5.0f, -2.5f);
	CHECK(l.reds == 3 && l.number == 3);
	l = LampState(RACE_COUNTDOWN, 0.5f, 5.0f, -0.5f);
	CHECK(l.reds == 5 && l.number == 1 && !l.green);
	l = LampState(RACE_COUNTDOWN, 0.01f, 5.0f, -0.01f);
	CHECK(l.reds == 5 && l.number == 1);
	// a countdown of another length lights them at the same shares
	l = LampState(RACE_COUNTDOWN, 5.0f, 10.0f, -5.0f);
	CHECK(l.reds == 3 && l.number == 5);
	l = LampState(RACE_COUNTDOWN, 9.0f, 3.0f, -9.0f); // more to go than the countdown is long
	CHECK(l.reds == 1);
	// the clock is past the green light and the server has not said so yet: green
	l = LampState(RACE_COUNTDOWN, -0.05f, 5.0f, 0.05f);
	CHECK(l.show && l.green && l.reds == 0 && l.number == 0);
	// the server says the race runs, the client's clock is not there yet: green
	l = LampState(RACE_RACING, 0.08f, 5.0f, -0.08f);
	CHECK(l.show && l.green);
	l = LampState(RACE_RACING, -1.0f, 5.0f, 1.0f);
	CHECK(l.show && l.green);
	l = LampState(RACE_RACING, -1.6f, 5.0f, 1.6f);
	CHECK(!l.show);
	l = LampState(RACE_WAITING, 3.0f, 5.0f, -3.0f);
	CHECK(!l.show);
	l = LampState(RACE_FINISHED, -50.0f, 5.0f, 0.5f);
	CHECK(!l.show);
}

static void CheckMap()
{
	// 1000 wide (east-west), 500 tall: fitted into 101 by 101 it is 100 wide and 50 tall, in the middle
	const Pt pts[4] = {{0, 0}, {1000, 0}, {1000, 500}, {0, 500}};
	const MapFit f = FitMap(pts, 4, 10, 20, 101, 101);
	CHECK(f.valid);
	CHECK(fabsf(f.scale - 0.1f) < 0.0001f);
	int x, y;
	MapPoint(f, 0, 500, x, y); // the north-west corner
	CHECK(x == 10 && y == 20 + 25);
	MapPoint(f, 1000, 0, x, y); // the south-east
	CHECK(x == 110 && y == 20 + 75);
	int nx, ny, sx, sy;
	MapPoint(f, 500, 400, nx, ny);
	MapPoint(f, 500, 100, sx, sy);
	CHECK(ny < sy && nx == sx); // north is up
	MapPoint(f, 5000, -5000, x, y); // off the line's extent: at the box's edge
	CHECK(x == 110 && y == 120);
	// taller than wide
	const Pt tall[3] = {{0, 0}, {100, 0}, {50, 400}};
	const MapFit g = FitMap(tall, 3, 0, 0, 81, 81);
	CHECK(fabsf(g.scale - 0.2f) < 0.0001f);
	MapPoint(g, 0, 0, x, y);
	CHECK(x == 30 && y == 80);
	MapPoint(g, 100, 400, x, y);
	CHECK(x == 50 && y == 0);
	// too few points, or one place twice
	CHECK(!FitMap(pts, 1, 0, 0, 50, 50).valid);
	const Pt one[2] = {{7, 7}, {7, 7}};
	const MapFit h = FitMap(one, 2, 0, 0, 50, 50);
	MapPoint(h, 7, 7, x, y);
	CHECK(x >= 0 && x < 50 && y >= 0 && y < 50);
}

static void CheckGauge()
{
	const float rIn = 40, rOut = 50;
	CHECK(ArcCell(0, -45, rIn, rOut, 0.5f, 24) != 0 || ArcCell(1.5f, -45, rIn, rOut, 0.5f, 24) != 0);
	CHECK(ArcCell(0, -30, rIn, rOut, 1, 24) == 0); // inside the ring
	CHECK(ArcCell(0, -60, rIn, rOut, 1, 24) == 0); // outside it
	CHECK(ArcCell(-45, 5, rIn, rOut, 1, 24) == 0); // under its foot
	int lit = 0, dark = 0, litRight = 0, darkLeft = 0;
	for (int dy = -50; dy <= 0; dy++)
		for (int dx = -50; dx <= 50; dx++)
		{
			const int c = ArcCell((float)dx, (float)dy, rIn, rOut, 0.5f, 24);
			lit += c == 2;
			dark += c == 1;
			litRight += c == 2 && dx > 2;
			darkLeft += c == 1 && dx < -2;
		}
	CHECK(lit > 100 && dark > 100);
	CHECK(litRight == 0 && darkLeft == 0); // half: lit on the left, dark on the right
	CHECK(abs(lit - dark) < (lit + dark) / 10);
	int none = 0, all = 0;
	for (int dy = -50; dy <= 0; dy++)
		for (int dx = -50; dx <= 50; dx++)
		{
			none += ArcCell((float)dx, (float)dy, rIn, rOut, 0, 24) == 2;
			all += ArcCell((float)dx, (float)dy, rIn, rOut, 1, 24) == 1;
		}
	CHECK(none == 0 && all == 0);
	// the first segment lights once the speed is past its middle
	CHECK(ArcCell(-45, -3, rIn, rOut, 0.01f, 24) == 1);
	CHECK(ArcCell(-45, -3, rIn, rOut, 0.03f, 24) == 2);
	const Col calm = SlipColour(0), mid = SlipColour(0.5f), wild = SlipColour(1);
	CHECK(calm.r == LIT.r && calm.g == LIT.g && calm.b == LIT.b);
	CHECK(mid.r == WARN.r && mid.g == WARN.g && mid.b == WARN.b);
	CHECK(wild.r == BAD.r && wild.g == BAD.g && wild.b == BAD.b);
}

static void CheckProtocol()
{
	CHECK(6 + RACE_HUD_LINE_POINTS * 4 <= 192);
	CHECK(2 + RACE_HUD_POS_RACERS * 8 <= 192);
	CHECK(4 + RACE_HUD_RES_ROWS * 12 <= 192);
	CHECK(RACE_MSG_STAT_SIZE == 6 + 2 + 1 + 2 + 4 * 4 + 2 * 4 + 4);
	CHECK(RACE_MSG_STATE_SIZE == 4 + 4 + 4 + 2);
	CHECK(RACE_MSG_NOTE_SIZE == 4 + 4 + 4);
	CHECK(MAX_DOTS >= 32 && MAX_ROWS >= 32 && (RACE_PP_PLACE & 32) != 0);
	CHECK(PixelSize(1280, 720) == 2 && PixelSize(1920, 1080) == 3 && PixelSize(1024, 768) == 2 && PixelSize(640, 480) == 1);
	CHECK(PixelSize(800, 600) == 1 && PixelSize(1280, 1024) == 2 && PixelSize(2560, 1440) == 4 && PixelSize(320, 200) == 1);
	static const int sizes[][2] = {{1280, 720}, {1920, 1080}, {1024, 768}, {800, 600}, {640, 480}, {1600, 900}, {1280, 1024}, {1366, 768}, {1440, 900}};
	for (const auto& size : sizes) // the layout's own screen is never under 500 by 300 units
		CHECK(size[0] / PixelSize(size[0], size[1]) >= 500 && size[1] / PixelSize(size[0], size[1]) >= 300);
}

// What shows when: a racer is one whose status is fresh; the table needs all its rows and goes by itself.
static void CheckLife()
{
	Model m;
	CHECK(!IsRacing(m, 10));
	m.haveStat = true;
	m.statAt = 10;
	CHECK(IsRacing(m, 10.5f));
	CHECK(!IsRacing(m, 10 + STAT_LIFE + 0.01f));
	CHECK(!IsRacing(m, 5)); // the clock went back (a new map): stale
	m.rowTotal = 4;
	m.rowCount = 3;
	m.rowsAt = 20;
	CHECK(!ResultsShown(m, 21)); // a part is still to come
	m.rowCount = 4;
	CHECK(ResultsShown(m, 21));
	CHECK(!ResultsShown(m, 20 + RESULTS_LIFE + 0.01f));
}

// Which pixels are drawn on, whatever the colour: how much of the screen the HUD takes, and whether any of it is over the road.
struct Mask : Canvas
{
	int w, h;
	std::vector<unsigned char> on;
	Mask(int W, int H) : w(W), h(H), on((size_t)W * H) {}
	void Fill(int x, int y, int fw, int fh, int, int, int, int a) override
	{
		if (a <= 0)
			return;
		for (int yy = y < 0 ? 0 : y; yy < y + fh && yy < h; yy++)
			for (int xx = x < 0 ? 0 : x; xx < x + fw && xx < w; xx++)
				on[(size_t)yy * w + xx] = 1;
	}
	int Width() override { return w; }
	int Height() override { return h; }
	// The pixels drawn on in the box [x0, x1) by [y0, y1).
	long Count(int x0, int y0, int x1, int y1) const
	{
		long n = 0;
		for (int yy = y0; yy < y1; yy++)
			for (int xx = x0; xx < x1; xx++)
				n += on[(size_t)yy * w + xx];
		return n;
	}
};

static long Area(const Bounds& b)
{
	return b.Empty() ? 0 : (long)(b.x1 - b.x0) * (b.y1 - b.y0);
}

// ---- rally mode: HL Rally's HUD (h9_rallyhud_draw.h). Every expected number comes from the HL Rally line cited beside it (the 1.1 source,
// cl_dll/rallyhud.cpp, tri.cpp, rally_hud_radar.cpp, rally_vguifx.cpp, hud_redraw.cpp; and the game's anim.txt). ---------------------------

// Every fill, with its colour: what the HUD drew, to ask where a colour went.
struct Rec : Canvas
{
	struct F
	{
		int x, y, w, h, r, g, b;
	};
	int w, h;
	std::vector<F> f;
	Rec(int W, int H) : w(W), h(H) {}
	void Fill(int x, int y, int fw, int fh, int r, int g, int b, int) override { f.push_back({x, y, fw, fh, r, g, b}); }
	int Width() override { return w; }
	int Height() override { return h; }
	bool Covers(const Col& c, int px, int py) const
	{
		for (const F& q : f)
			if (q.r == c.r && q.g == c.g && q.b == c.b && px >= q.x && px < q.x + q.w && py >= q.y && py < q.y + q.h)
				return true;
		return false;
	}
	int Count(const Col& c) const
	{
		int n = 0;
		for (const F& q : f)
			n += (q.r == c.r && q.g == c.g && q.b == c.b);
		return n;
	}
};

static void RallyModelOn(Model& m, RallyModel& rm, const MapData& map, float now)
{
	BaseModel(m, map, now);
	m.local = 3;
	rm = RallyModel();
	rm.third = true;
	rm.speed3d = 680;
	rm.gear = 4;
	rm.cpCur = 2;
	rm.cpTotalNote = 0;
	rm.haveOrg = true;
	rm.org[0] = 3200;
	rm.org[1] = -1600;
}

static void CheckRallyNumbers()
{
	char c[9];
	// hud_redraw.cpp:327-410 DrawHudNumber2
	NumberCells(0, RH_3DIGITS | RH_DRAWZERO, c); // :395-409: both blanks, then the 0
	CHECK(Same(c, "  0"));
	NumberCells(5, RH_3DIGITS | RH_DRAWZERO, c); // :356-362, :371-376
	CHECK(Same(c, "  5"));
	NumberCells(45, RH_3DIGITS | RH_DRAWZERO, c);
	CHECK(Same(c, " 45"));
	NumberCells(227, RH_3DIGITS | RH_DRAWZERO, c);
	CHECK(Same(c, "227"));
	NumberCells(7, RH_2DIGITS | RH_DRAWZERO, c);
	CHECK(Same(c, " 7"));
	NumberCells(0, RH_DRAWZERO, c); // gear 0 with no letter, a lone 0
	CHECK(Same(c, "0"));
	NumberCells(0, 0, c); // no DRAWZERO: nothing
	CHECK(Same(c, ""));
	NumberCells(12, RH_DRAWZERO, c); // the checkpoint counter at 10 and over
	CHECK(Same(c, "12"));
	NumberCells(3, RH_DRAWZERO, c);
	CHECK(Same(c, "3"));

	// rallyhud.cpp:961-987: Length(velocity) / 3, under 9 is 0, an int parameter: truncated
	CHECK(RallySpeedShown(680) == 226);    // 226.67 -> 226 (ours rounded: 227)
	CHECK(RallySpeedShown(301.8f) == 100); // 100.6 -> 100, as the audit's example
	CHECK(RallySpeedShown(26) == 0);       // 8.67 < 9
	CHECK(RallySpeedShown(27) == 9);       // 9.0 is not under 9
	CHECK(RallySpeedShown(0) == 0);
	CHECK(RallySpeedShown(-680) == 0);     // Length is never negative; no sign reaches here, and no REVERSE word exists in HL Rally
	CHECK(RallySpeedShown(1e9f) == 999);

	// rallyhud.cpp:673-691 DrawTime (float): minutes, seconds, hundredths cut; :603-636 their cells; -1 is none (:640-669)
	char t[9];
	TimeCells(TimeOf(83.5f), t);
	CHECK(Same(t, " 1:23:50")); // minutes under ten: a BLANK tens (DHN_2DIGITS, no 0 appended: :606-607), seconds and hundredths with a 0
	TimeCells(TimeOf(5.0f), t);
	CHECK(Same(t, " 0:05:00")); // :618-621, :631-634
	TimeCells(TimeOf(600.25f), t);
	CHECK(Same(t, "10:00:25"));
	TimeCells(TimeOf(3725.5f), t);
	CHECK(Same(t, "62:05:50"));
	TimeCells(TimeOf(-1), t);
	CHECK(Same(t, " -:--:--")); // hyphens at x + 16, 48, 64, 96, 112 and colons at 32, 80 (:644-668): cells 1, 3, 4, 6, 7 and 2, 5
	CHECK(t[1] == '-' && t[2] == ':' && t[3] == '-' && t[4] == '-' && t[5] == ':' && t[6] == '-' && t[7] == '-' && t[0] == ' ');
	TimeCells(TimeOf(-3.5f), t); // a negative time draws zeros (DrawHudNumber2 draws 0 for a number that is not above 0)
	CHECK(Same(t, " 0:00:00"));
	TimeCells(TimeOfCs(4211), t);
	CHECK(Same(t, " 0:42:11"));
	TimeCells(TimeOfCs(0), t);
	CHECK(Same(t, " 0:00:00"));
	TimeCells(TimeOfCs(6000 * 12 + 345), t);
	CHECK(Same(t, "12:03:45"));
	TimeCells(TimeOfCs(-1), t);
	CHECK(Same(t, " -:--:--"));

	// rallyhud.cpp:1117-1126: the lap's time stays for 4 s after the lap's start, blinking: lit while frac < 0.4 or frac > 0.8
	CHECK(LastLapShown(3.9f, 4100));
	CHECK(!LastLapShown(4.0f, 4100));
	CHECK(!LastLapShown(1.0f, -1)); // fLastLap == -1: no
	CHECK(LastLapLit(10.0f));
	CHECK(LastLapLit(10.2f));
	CHECK(!LastLapLit(10.5f));
	CHECK(!LastLapLit(10.7f));
	CHECK(LastLapLit(10.85f));
	CHECK(LastLapLit(10.95f));

	// input.cpp:869-875, 942-945: g_reversing
	CHECK(RallyReversing(false, true, false, true, 10));   // back key under 40 u/s, forward key up
	CHECK(!RallyReversing(true, true, false, true, 50));   // 40 and over: no
	CHECK(!RallyReversing(true, true, true, true, 10));    // the forward key up is what makes it reverse
	CHECK(!RallyReversing(false, true, false, false, 0));  // no back key
	CHECK(RallyReversing(true, false, false, false, 100)); // in the air it stays as it was
	CHECK(!RallyReversing(false, false, false, true, 0));
}

static void CheckRallyLayout()
{
	// the offsets from the screen's edges, rallyhud.cpp, tri.cpp, rally_hud_radar.cpp: the same at every size, from the same edge
	static const int sizes[][2] = {{640, 480}, {800, 600}, {1280, 720}, {1920, 1080}, {1024, 768}};
	for (const auto& s : sizes)
	{
		const int W = s[0], H = s[1];
		const RallyLayout l = RallyLayoutFor(W, H);
		CHECK(l.dialsX == W - 224 && l.dialsY == H - 232); // :974-975
		CHECK(l.speedX == W - 52 && l.speedY == H - 32);   // :980-981
		CHECK(l.gearX == W - 152 && l.gearY == H - 32);    // :1182-1183
		CHECK(l.needleX == W - 78 && l.needleY == H - 79); // tri.cpp:113-114
		CHECK(l.timeX == W - 176);                          // :1098
		CHECK(l.totalLabelY == 16 && l.totalY == 36 && l.lapLabelY == 60 && l.lapY == 80 && l.bestLabelY == 104 && l.bestY == 124); // :1101-1141
		CHECK(l.leftX == 8 && l.leftY == H - 32);           // :1158
		CHECK(l.mapX == 20 && l.mapY == H - 173);           // rally_hud_radar.cpp:152-153
	}
	// the place: ScreenWidth / 2 - 24, or - 32 from 10 (:1063-1078), the suffix 16 / 32 on
	PlaceDraw p = PlaceLayout(640, 3);
	CHECK(p.cells == 1 && p.x == 296 && p.suffixX == 312 && p.suffix == 2 && p.digit[0] == '3');
	p = PlaceLayout(1920, 1);
	CHECK(p.x == 936 && p.suffixX == 952 && p.suffix == 0);
	p = PlaceLayout(1280, 12);
	CHECK(p.cells == 2 && p.x == 608 && p.suffixX == 640 && p.suffix == 3 && p.digit[0] == '1' && p.digit[1] == '2');
	// :1080 `(leftover > 0) && (leftover < 4) && (tens != 1)`
	CHECK(PlaceLayout(640, 21).suffix == 0);
	CHECK(PlaceLayout(640, 22).suffix == 1);
	CHECK(PlaceLayout(640, 23).suffix == 2);
	CHECK(PlaceLayout(640, 11).suffix == 3);
	CHECK(PlaceLayout(640, 12).suffix == 3);
	CHECK(PlaceLayout(640, 13).suffix == 3);
	CHECK(PlaceLayout(640, 4).suffix == 3);
	CHECK(PlaceLayout(640, 9).suffix == 3);
	CHECK(PlaceLayout(640, 10).suffix == 3);
	// the checkpoint counter (:1034-1054): x 16, +8, then 16 a cell (32 for two digits)
	CpDraw d = CpLayout(1, 3);
	CHECK(d.leftX == 16 && d.curX == 24 && d.slashX == 40 && d.totalX == 56 && d.rightX == 72 && d.curCells == 1);
	d = CpLayout(10, 12);
	CHECK(d.curX == 24 && d.curCells == 2 && d.slashX == 56 && d.totalX == 72 && d.rightX == 104);
	d = CpLayout(3, 12);
	CHECK(d.slashX == 40 && d.totalX == 56 && d.rightX == 88);
	d = CpLayout(12, 9);
	CHECK(d.slashX == 56 && d.totalX == 72 && d.rightX == 88);

	// tri.cpp:113-135 the needle: centre (W - 78, H - 79), hyp = 75 * sqrt 2, D = 0.0174532
	float q[4][2];
	NeedleQuad(640, 480, 45.0f, q); // at 45 degrees the square stands as drawn: 150 across, the corners 75 from the centre
	CHECK(fabsf(q[0][0] - 487) < 0.05f && fabsf(q[0][1] - 476) < 0.05f);
	CHECK(fabsf(q[1][0] - 487) < 0.05f && fabsf(q[1][1] - 326) < 0.05f);
	CHECK(fabsf(q[2][0] - 637) < 0.05f && fabsf(q[2][1] - 326) < 0.05f);
	CHECK(fabsf(q[3][0] - 637) < 0.05f && fabsf(q[3][1] - 476) < 0.05f);
	NeedleQuad(640, 480, 15.0f, q); // the lowest rpm: OfsX = sin 15 * 106.066 = 27.45, OfsY = cos 15 * 106.066 = 102.45
	CHECK(fabsf(q[0][0] - (562 - 27.45f)) < 0.1f && fabsf(q[0][1] - (401 + 102.45f)) < 0.1f);
	CHECK(fabsf(q[1][0] - (562 - 102.45f)) < 0.1f && fabsf(q[1][1] - (401 - 27.45f)) < 0.1f);
	CHECK(fabsf(q[2][0] - (562 + 27.45f)) < 0.1f && fabsf(q[2][1] - (401 - 102.45f)) < 0.1f);
	CHECK(fabsf(q[3][0] - (562 + 102.45f)) < 0.1f && fabsf(q[3][1] - (401 + 27.45f)) < 0.1f);
	NeedleQuad(1280, 720, 250.0f, q); // the highest: anchored to the bottom right whatever the width
	CHECK(fabsf(q[0][0] - (1202 - sinf(250 * 0.0174532f) * 106.066f)) < 0.1f);
	CHECK(fabsf(q[2][1] - (641 - cosf(250 * 0.0174532f) * 106.066f)) < 0.1f);
	// the square's diagonal is 2 * 106.066 and its centre fixed, whatever the angle
	for (float rpm = 15; rpm <= 250; rpm += 17.5f)
	{
		NeedleQuad(800, 600, rpm, q);
		const float ex = q[2][0] - q[0][0], ey = q[2][1] - q[0][1];
		CHECK(fabsf(sqrtf(ex * ex + ey * ey) - 2 * 106.066f) < 0.2f);
		CHECK(fabsf((q[0][0] + q[2][0]) / 2 - 722) < 0.05f && fabsf((q[0][1] + q[2][1]) / 2 - 521) < 0.05f);
	}

	// rally_hud_radar.cpp: the server's byte (player.cpp:2591-2592 int(origin / 32) + 128, as a byte), the smoothing, the squares
	CHECK(RadarByte(0) == 128);
	CHECK(RadarByte(400) == 228);  // world 3200
	CHECK(RadarByte(-400) == 28);  // world -3200
	CHECK(RadarByte(1024) == 128); // world 8192: 256 + 128 wraps as a byte
	CHECK(fabsf(RadarSmooth(0, 100) - 100.0f / 7) < 1e-4f); // :193-194 ((g * 6) + m) / 7
	CHECK(fabsf(RadarSmooth(50, 100) - (300 + 100) / 7.0f) < 1e-4f);
	int x, y;
	RadarOther(480, 100, 50, x, y); // :258-259 pos / 2 + 22, (H - 45) + pos / -2
	CHECK(x == 72 && y == 410);
	RadarOther(1080, 255, 255, x, y);
	CHECK(x == 149 && y == 907);
	RadarSelf(480, 3200, -1600, x, y); // :314-319 origin / 32 + 128, then / 2 + 22 and (H - 45) - /2
	CHECK(x == 136 && y == 396);
	CHECK(RadarMapX() == 20 && RadarMapY(480) == 307);
}

static void CheckRallyCountdown()
{
	// rally_vguifx.cpp:612-662: one model per call at most, the n-th at n - 1 seconds, nothing after 4 s
	CountSeq s = {10.0f, 0};
	CHECK(CountNext(s, 10.0f) == 1); // three at 0 s
	CHECK(CountNext(s, 10.0f) == 0);
	CHECK(CountNext(s, 10.99f) == 0);
	CHECK(CountNext(s, 11.0f) == 2); // two at 1 s
	CHECK(CountNext(s, 11.5f) == 0);
	CHECK(CountNext(s, 12.0f) == 3); // one at 2 s
	CHECK(CountNext(s, 12.99f) == 0);
	CHECK(CountNext(s, 13.0f) == 4); // go at 3 s
	CHECK(CountNext(s, 13.5f) == 0);
	CHECK(CountNext(s, 20.0f) == 0); // done == 4
	CountSeq late = {10.0f, 0};
	CHECK(CountNext(late, 12.5f) == 1 && CountNext(late, 12.5f) == 2 && CountNext(late, 12.5f) == 3 && CountNext(late, 12.5f) == 0); // one a call, 2.5 s in
	CountSeq gone = {10.0f, 0};
	CHECK(CountNext(gone, 14.01f) == 0); // (start + 4) < now: not at all
	CHECK(Same(CountModelName(1), "three") && Same(CountModelName(2), "two") && Same(CountModelName(3), "one") && Same(CountModelName(4), "go"));

	// anim.txt [Numbers]: Origin=90, 5, 0; Scale=4.0; Length=1.0; nodes Position / Angle / Time
	CHECK(COUNT_AHEAD == 90 && COUNT_UP == 5 && COUNT_RIGHT == 0 && COUNT_SCALE == 4.0f && COUNT_LENGTH == 1.0f && COUNT_LIGHT == 40);
	CHECK(COUNT_NODES[0].time == 0.0f && COUNT_NODES[1].time == 0.2f && COUNT_NODES[2].time == 0.4f && COUNT_NODES[3].time == 0.6f);
	CHECK(COUNT_NODES[1].ang[0] == -180 && COUNT_NODES[2].ang[0] == -90 && COUNT_NODES[2].ang[2] == -90 && COUNT_NODES[3].ang[1] == 180);

	// looking down +x (angles 0 0 0): forward +x, right -y, up +z (AngleVectors). The camera at (100, 200, 50).
	const float cam[3] = {100, 200, 50}, ang0[3] = {0, 0, 0};
	float start[3], org[3], ang[3];
	CountStart(cam, ang0, start); // 90 ahead, 5 up
	CHECK(fabsf(start[0] - 190) < 1e-3f && fabsf(start[1] - 200) < 1e-3f && fabsf(start[2] - 55) < 1e-3f);
	// the callback's path: positions are right, up, forward times the scale (:728-729: position[0] right, [1] up, [2] forward)
	CountPose(0.0f, start, ang0, ang0, org, ang); // node 0: up 20 * 4 = 80, forward 15 * 4 = 60
	CHECK(fabsf(org[0] - 250) < 1e-3f && fabsf(org[1] - 200) < 1e-3f && fabsf(org[2] - 135) < 1e-3f);
	CHECK(fabsf(ang[0]) < 1e-3f && fabsf(ang[1]) < 1e-3f && fabsf(ang[2]) < 1e-3f);
	CountPose(0.1f, start, ang0, ang0, org, ang); // half way to node 1 (up 12, forward -20): angles the short way from 0 to -180: -90
	CHECK(fabsf(org[0] - 210) < 1e-2f && fabsf(org[2] - 101) < 1e-2f);
	CHECK(fabsf(ang[0] + 90) < 1e-2f && fabsf(ang[1] + 90) < 1e-2f && fabsf(ang[2] + 90) < 1e-2f);
	CountPose(0.3f, start, ang0, ang0, org, ang); // half way from node 1 (-180 -180 -180) to node 2 (-90 0 -90): pitch -135, yaw -90 (a 180 step), roll -135
	CHECK(fabsf(ang[0] + 135) < 1e-2f && fabsf(ang[1] + 90) < 1e-2f && fabsf(ang[2] + 135) < 1e-2f);
	CountPose(0.5f, start, ang0, ang0, org, ang); // node 2 (-90 0 -90) to node 3 (0 180 0): -45, 90, -45
	CHECK(fabsf(ang[0] + 45) < 1e-2f && fabsf(ang[1] - 90) < 1e-2f && fabsf(ang[2] + 45) < 1e-2f);
	CountPose(0.6f, start, ang0, ang0, org, ang); // the end of the path: node 3, up 4, forward -60, angles 0 180 0, and it stays
	CHECK(fabsf(org[0] - 130) < 1e-3f && fabsf(org[1] - 200) < 1e-3f && fabsf(org[2] - 59) < 1e-3f);
	CHECK(fabsf(ang[0]) < 1e-3f && fabsf(ang[1] - 180) < 1e-3f && fabsf(ang[2]) < 1e-3f);
	CountPose(0.9f, start, ang0, ang0, org, ang);
	CHECK(fabsf(org[0] - 130) < 1e-3f && fabsf(org[2] - 59) < 1e-3f);
	// the numeral follows the view: the start stays, the path turns with the camera (now looking down +y: forward +y)
	const float ang90[3] = {0, 90, 0};
	CountPose(0.6f, start, ang0, ang90, org, ang);
	CHECK(fabsf(org[0] - 190) < 1e-3f && fabsf(org[1] - 140) < 1e-3f && fabsf(org[2] - 59) < 1e-3f); // forward -60 is now -y
	// a start in a view looking down +y is 90 along +y
	CountStart(cam, ang90, start);
	CHECK(fabsf(start[0] - 100) < 1e-3f && fabsf(start[1] - 290) < 1e-3f && fabsf(start[2] - 55) < 1e-3f);
}

// A number that tells two drawings apart.
static long Sig(const Rec& r)
{
	long h = 0;
	for (const Rec::F& q : r.f)
		h = h * 31 + q.x * 7 + q.y * 13 + q.w * 3 + q.h;
	return h;
}

static bool InTop(const Rec& r, int W, int H)
{
	bool middle = false;
	for (const Rec::F& q : r.f)
		if (q.x < W / 2 + 60 && q.x + q.w > W / 2 - 60 && q.y + q.h > 60 && q.y < H - 60)
			middle = true;
	return middle;
}

// A rally scene at many sizes: every piece in the place HL Rally gives it, nothing off the screen, nothing in the middle of the road.
static void CheckRallyPaint(const MapData& map)
{
	static const int sizes[][2] = {{640, 480}, {800, 600}, {1280, 720}, {1920, 1080}, {1024, 768}, {1366, 768}, {2560, 1440}};
	const float now = 500;
	for (const auto& sz : sizes)
	{
		const int W = sz[0], H = sz[1];
		for (int third = 0; third < 2; third++)
		{
			Model m;
			RallyModel rm;
			RallyModelOn(m, rm, map, now);
			rm.third = third != 0;
			m.state = RACE_RACING;
			m.t0 = m.raceStart = now - 83.5f;
			m.lapStart = now - 41.25f;
			Rec rec(W, H);
			{
				RallyModel a = rm;
				RallyPainter(rec, m, a, now).Paint();
			}
			CHECK(!rec.f.empty());
			bool outside = false;
			for (const Rec::F& q : rec.f)
				outside |= q.x < 0 || q.y < 0 || q.x + q.w > W || q.y + q.h > H;
			CHECK(!outside);
			CHECK(!InTop(rec, W, H));

			Bounds speed(W, H), lap(W, H), cp(W, H), place(W, H), clocks(W, H);
			RallyModel a = rm;
			RallyPainter(speed, m, a, now).Speed3(); // the speed from W - 52 (:980-981) and the gear from W - 152 (:1182)
			CHECK(!speed.Empty() && speed.x0 >= W - 152 - 1 && speed.x1 <= W - 4 + 1);
			CHECK(speed.y0 >= H - 32 - 1 && speed.y1 <= H - 32 + 19 + 1);
			RallyPainter(lap, m, a, now).Lap();
			RallyPainter(cp, m, a, now).Checkpoints();
			RallyPainter(place, m, a, now).PlaceDigits();
			RallyPainter(clocks, m, a, now).Clocks3();
			CHECK(!lap.Empty() && lap.x0 >= 20 - 1 && lap.y0 >= 16 - 1 && lap.x1 <= 56 + 16 + 1 + 40 && lap.y1 <= 56 + 44 + 1);                    // :1001-1018
			CHECK(!cp.Empty() && cp.x0 >= 16 - 1 && cp.y0 >= 106 - 1 && cp.y1 <= 106 + 19 + 1);                                                 // :1034-1054
			CHECK(!place.Empty() && place.y0 >= 16 - 1 && place.y1 <= 16 + 37 + 1 && place.x0 >= W / 2 - 24 - 1 && place.x1 <= W / 2 + 24 + 36); // :1063-1088
			CHECK(!clocks.Empty() && clocks.x0 >= W - 176 - 1 && clocks.x1 <= W - 176 + 16 * 8 + 4 && clocks.y0 >= 16 - 1 && clocks.y1 <= 124 + 19 + 1); // :1098-1141

			// :1062 the place only in the views that show the car: Paint draws it when third, and not otherwise
			bool placeUp = false;
			for (const Rec::F& q : rec.f)
				placeUp |= q.y >= 16 - 1 && q.y + q.h <= 16 + 38 && q.x >= W / 2 - 25 && q.x + q.w <= W / 2 + 60;
			CHECK(placeUp == (third != 0));
		}
	}
}

static void CheckRallyContent(const MapData& map)
{
	const int W = 1280, H = 720;
	const float now = 500;
	Model m;
	RallyModel rm;
	RallyModelOn(m, rm, map, now);
	m.state = RACE_RACING;
	m.t0 = m.raceStart = now - 83.5f;
	m.lapStart = now - 41.25f;

	// what ours drew and HL Rally does not is gone: a note, wrong way, the countdown's lamps, the REVERSE word, the gauge
	Rec base(W, H);
	{
		RallyModel a = rm;
		RallyPainter(base, m, a, now).Paint();
	}
	Model n = m;
	n.noteKind = RACE_NOTE_CHECKPOINT;
	n.noteA = 3;
	n.noteB = 7;
	n.noteTime = 2317;
	n.noteAt = now - 1;
	n.flags |= RACE_SF_WRONGWAY;
	Rec withNote(W, H);
	{
		RallyModel a = rm;
		RallyPainter(withNote, n, a, now).Paint();
	}
	CHECK(withNote.f.size() == base.f.size()); // no note and no WRONG WAY in rally mode
	Model cd = m;
	cd.state = RACE_COUNTDOWN;
	cd.t0 = now + 2.6f;
	cd.raceStart = cd.t0;
	Rec lamps(W, H);
	{
		RallyModel a = rm;
		RallyPainter(lamps, cd, a, now).Paint();
		CHECK(lamps.Count(LAMP_RED) == 0 && lamps.Count(LAMP_GREEN) == 0 && lamps.Count(LAMP_OFF) == 0); // no lamps
	}
	Model wu = m;
	wu.state = RACE_WAITING;
	wu.t0 = now + 6.4f;
	Rec warm(W, H);
	{
		RallyModel a = rm;
		a.third = false; // the place is not up in the interior: the top's middle is then empty
		RallyPainter(warm, wu, a, now).Paint();
		bool topMiddle = false;
		for (const Rec::F& q : warm.f)
			topMiddle |= q.y < 40 && q.x < W / 2 + 100 && q.x + q.w > W / 2 - 100;
		CHECK(!topMiddle); // no "RACE STARTS IN" there
	}
	// reverse is the letter R in the gear box, not a word (:1196-1201); N at gear 0 (:1203-1207), the digit otherwise (:1208)
	{
		Rec rev(W, H), neu(W, H), g3(W, H);
		RallyModel a = rm, b = rm, c = rm;
		a.reversing = true;
		a.gear = 0;
		b.gear = 0;
		c.gear = 3;
		RallyPainter(rev, m, a, now).Speed3();
		RallyPainter(neu, m, b, now).Speed3();
		RallyPainter(g3, m, c, now).Speed3();
		CHECK(Sig(rev) != Sig(neu)); // R and N are different letters
		CHECK(Sig(g3) != Sig(neu));
		CHECK(Sig(g3) != Sig(rev));
	}
	// the colours: the lap and the place white, the rest orange 255 75 14
	CHECK(base.Count(RH_ORANGE) > 0 && base.Count(RH_WHITE) > 0);
	// the finished lap's time: grey while it blinks, for 4 s from the lap's start (:1117-1126)
	{
		RallyModel a = rm;
		a.lastLapCs = 4100;
		Model k = m;
		k.lapStart = now - 2.0f;
		Rec lit(W, H), off(W, H);
		RallyPainter(lit, k, a, 500.0f).Clocks3();
		RallyPainter(off, k, a, 500.5f).Clocks3();
		CHECK(lit.Count(RH_GREY) > 0);  // frac 0.0: lit
		CHECK(off.Count(RH_GREY) == 0); // frac 0.5: off, and nothing in orange in its place on that row
		const RallyLayout l = RallyLayoutFor(W, H);
		bool lapRowOff = true;
		for (const Rec::F& q : off.f)
			lapRowOff &= !(q.y >= l.lapY && q.y < l.lapY + 19 && q.x >= l.timeX && q.x < l.timeX + 128 && q.r == 255 && q.g == 75 && q.b == 14);
		CHECK(lapRowOff);
		Rec after(W, H);
		k.lapStart = now - 4.5f; // over: the lap's running time, orange
		RallyPainter(after, k, a, 500.0f).Clocks3();
		CHECK(after.Count(RH_GREY) == 0);
	}
	// the time left: red at (8, H - 32) in the last 30 s once the first has finished, or in the time-extension mode (:1150-1180)
	{
		Model k = m;
		k.state = RACE_FINISHED;
		k.t0 = now + 20.0f;
		RallyModel a = rm;
		Rec r(W, H);
		RallyPainter(r, k, a, now).TimeLeft();
		CHECK(r.Count(RH_RED) > 0);
		bool placed = true;
		for (const Rec::F& q : r.f)
			placed &= q.x >= 8 - 1 && q.y >= H - 32 - 1 && q.x + q.w <= 8 + 16 * 8 + 1;
		CHECK(placed);
		k.t0 = now + 45.0f; // more than 30 s to go: not shown
		Rec r2(W, H);
		RallyPainter(r2, k, a, now).TimeLeft();
		CHECK(r2.Count(RH_RED) == 0);
		Model j = m;
		j.limitEnd = now + 100;
		Rec r3(W, H);
		RallyPainter(r3, j, a, now).TimeLeft();
		CHECK(r3.Count(RH_RED) > 0);
		// before the green light, with an allowance: the whole of it (:1176-1177); with none, nothing
		Model w = m;
		w.state = RACE_COUNTDOWN;
		w.raceStart = 0;
		w.limitEnd = 0;
		w.limitLen = 90;
		Rec r4(W, H), r5(W, H);
		RallyPainter(r4, w, a, now).TimeLeft();
		CHECK(r4.Count(RH_RED) > 0);
		w.limitLen = 0;
		RallyPainter(r5, w, a, now).TimeLeft();
		CHECK(r5.Count(RH_RED) == 0);
	}
	// the radar's squares over the map's picture (:204-345): the others red 8 x 8 at pos/2 + 22, the player green
	{
		RallyModel a = rm;
		a.mapSprite = true;
		Model k = m;
		k.dotCount = 2;
		k.dots[0].index = 3; // the player's own, not drawn from the list
		k.dots[0].x = 0;
		k.dots[0].y = 0;
		k.dots[1].index = 5;
		k.dots[1].x = 400; // world 3200 -> byte 228
		k.dots[1].y = 200; // world 1600 -> byte 178
		float gx = 0, gy = 0;
		for (int frame = 0; frame < 3; frame++)
		{
			Rec fr(W, H);
			RallyPainter(fr, k, a, now).RadarSquares();
			gx = RadarSmooth(gx, 228);
			gy = RadarSmooth(gy, 178);
			CHECK(fabsf(a.radarX[0] - gx) < 1e-3f && fabsf(a.radarY[0] - gy) < 1e-3f); // smoothed from 0, a seventh a frame
			if (frame == 2)
			{
				int x, y;
				RadarOther(H, gx, gy, x, y);
				CHECK(fr.Covers(RH_RADAR_OTHER, x, y) && !fr.Covers(RH_RADAR_OTHER, x - 4, y - 4)); // the corner is cut
				CHECK(fr.Covers(RH_RADAR_OTHER, x - 4, y) && fr.Covers(RH_RADAR_OTHER, x + 3, y) && !fr.Covers(RH_RADAR_OTHER, x + 4, y));
				RadarSelf(H, 3200, -1600, x, y);
				CHECK(fr.Covers(RH_RADAR_SELF, x, y));
				CHECK(fr.Count(RH_RADAR_SELF) == 2 && fr.Count(RH_RADAR_OTHER) == 2);
			}
		}
		// no picture: no squares, and our lap line is drawn as before
		RallyModel nb = rm;
		Rec no(W, H);
		RallyPainter(no, k, nb, now).RadarSquares();
		CHECK(no.Count(RH_RADAR_SELF) == 0 && no.Count(RH_RADAR_OTHER) == 0);
		Rec line(W, H), picture(W, H);
		RallyModel l1 = rm, l2 = rm;
		l2.mapSprite = true;
		Model k2 = m;
		RallyPainter(line, k2, l1, now).Paint();
		RallyPainter(picture, k2, l2, now).Paint();
		CHECK(line.f.size() > picture.f.size()); // the lap line stands in for the picture
	}
	// before the green light the clocks are --:--:-- (rallyhud.cpp:1105-1110: fRaceStart is -1 until SetTimer)
	{
		Model k = m;
		k.state = RACE_COUNTDOWN;
		k.raceStart = now + 3.0f;
		k.lapStart = now + 3.0f;
		RallyModel a = rm;
		Rec r(W, H);
		RallyPainter(r, k, a, now).Clocks3();
		const RallyLayout l = RallyLayoutFor(W, H);
		CHECK(r.Covers(RH_ORANGE, l.timeX + 16 + 6, l.totalY + 9));  // the hyphen's bar in the second cell (x + 16)
		CHECK(!r.Covers(RH_ORANGE, l.timeX + 16 + 6, l.totalY + 2)); // and no digit's top stroke over it
		CHECK(!r.Covers(RH_ORANGE, l.timeX + 6, l.totalY + 9));      // the first cell is blank
	}
}

// Every scene at every size: nothing leaves the screen, no part stands on another, and while the race runs the HUD is four small
// pieces in the corners: nothing in the middle of the screen, and little of the screen taken.
static void CheckLayout(const MapData& map)
{
	static const int sizes[][2] = {{1280, 720}, {1920, 1080}, {1024, 768}, {800, 600}, {640, 480}, {1600, 900}, {2560, 1440}, {1280, 1024}, {3440, 1440}, {1366, 768}, {1440, 900}};
	const float now = 500;
	for (const auto& size : sizes)
	{
		const int W = size[0], H = size[1], u = PixelSize(W, H);
		for (const char* scene : kScenes)
		{
			Model m;
			Scene(scene, m, map, now);
			Bounds whole(W, H);
			Painter all(whole, m, now);
			all.Paint();
			if (whole.outside || whole.Empty())
				printf("  %s at %dx%d: %s\n", scene, W, H, whole.Empty() ? "nothing drawn" : "drawn off the screen");
			CHECK(!whole.outside);
			CHECK(!whole.Empty());
			if (Same(scene, "results"))
			{
				// the table is a panel in the middle, and not a large one: under a fifth of the screen, clear of its sides
				CHECK(Area(whole) * 5 < (long)W * H);
				CHECK(whole.x0 >= 8 * u && whole.x1 <= W - 8 * u && whole.y0 >= 8 * u && whole.y1 <= H - 8 * u);
				continue;
			}
			Bounds place(W, H), clocks(W, H), speed(W, H), mini(W, H), lights(W, H), notes(W, H);
			Painter(place, m, now).Place();
			Painter(clocks, m, now).Clocks();
			Painter(speed, m, now).Speed();
			Painter(mini, m, now).Minimap();
			Painter(lights, m, now).StartLights();
			Painter(notes, m, now + 0.1f).Notes(); // a moment when "wrong way" is lit
			CHECK(mini.Empty() || mini.x1 <= MapRight(W, H)); // the chat begins to the right of it (H9RaceHud_ChatLeft)
			const Bounds* parts[6] = {&place, &clocks, &speed, &mini, &lights, &notes};
			static const char* const names[6] = {"the place", "the clocks", "the speed", "the map", "the lights", "the notes"};
			for (int i = 0; i < 6; i++)
				for (int k = i + 1; k < 6; k++)
				{
					if (!Apart(*parts[i], *parts[k]))
						printf("  %s at %dx%d: %s is over %s\n", scene, W, H, names[i], names[k]);
					CHECK(Apart(*parts[i], *parts[k]));
				}
			// TS's round timer (roundtime.cpp: at ScreenWidth - 72, 12, some 64 by 16 pixels) stays clear
			Bounds timer(W, H);
			timer.Fill(W - 72, 12, 64, 16, 0, 0, 0, 0);
			for (int i = 0; i < 6; i++)
				CHECK(Apart(*parts[i], timer));

			// each corner's piece is in its corner, a margin from the screen's sides (the dark edge, a pixel or two, may stand in the
			// margin), and small: in units, so at 1280x720 twice that in pixels
			const int edge = HUD_EDGE * u - (u + 1) / 2, rim = 2 * ((u + 1) / 2) + u / 2;
			const struct
			{
				const Bounds* b;
				bool left, top;
				int maxW, maxH;
			} corners[4] = {
				{&place, true, true, 72, 43},    // 144 by 86 at 1280x720 with a two-figure lap and place; some 90 wide with one
				{&clocks, false, true, 70, 47},  // 140 by 94 with all five clocks; 138 by 54 with the usual three
				{&mini, true, false, MAP_SIZE, MAP_SIZE},
				{&speed, false, false, 2 * GAUGE_R + 1, GAUGE_R + 9},
			};
			for (int i = 0; i < 4; i++)
			{
				const Bounds& b = *corners[i].b;
				if (b.Empty())
					continue;
				const bool in = (corners[i].left ? b.x0 >= edge && b.x1 <= W / 5 : b.x1 <= W - edge + u / 2 && b.x0 >= W - W / 5) &&
								(corners[i].top ? b.y0 >= edge && b.y1 <= H / 2 : b.y1 <= H - edge + u / 2 && b.y0 >= H / 2);
				const bool small = b.x1 - b.x0 <= corners[i].maxW * u + rim && b.y1 - b.y0 <= corners[i].maxH * u + rim;
				if (!in || !small)
					printf("  %s at %dx%d: %s is %d by %d at %d, %d (%s)\n", scene, W, H, names[i == 2 ? 3 : (i == 3 ? 2 : i)], b.x1 - b.x0, b.y1 - b.y0, b.x0,
						b.y0, !in ? "not in its corner" : "too large");
				CHECK(in);
				CHECK(small);
			}
			// what comes and goes stands along the top, about the middle
			for (const Bounds* b : {&lights, &notes})
				if (!b->Empty())
				{
					CHECK(b->y0 >= edge && b->y1 <= H / 5);
					CHECK(b->x0 > W / 5 && b->x1 < W - W / 5);
					CHECK(abs((b->x0 + b->x1) / 2 - W / 2) <= 2 * u);
				}

			// nothing is drawn in the middle of the screen (its middle 60% each way): that is the road's
			Mask mask(W, H);
			Painter(mask, m, now).Paint();
			Painter(mask, m, now + 0.1f).Paint();
			const long middle = mask.Count(W / 5, H / 5, W - W / 5, H - H / 5);
			if (middle)
				printf("  %s at %dx%d: %ld pixels drawn in the middle of the screen\n", scene, W, H, middle);
			CHECK(middle == 0);
			// and the HUD takes little of the screen: the boxes round the four corners' pieces under 4% of it at the sizes the layout
			// is made for (16:9 with a whole unit: 1280x720, 1920x1080, 2560x1440) and the pixels really drawn on, notes and all, under
			// 3%; under 7% and 4% at any size and with all five clocks up (a 4:3 screen has fewer pixels for the same pieces, and
			// 1600x900 rounds its unit up to 3)
			const long boxes = Area(place) + Area(clocks) + Area(mini) + Area(speed), screen = (long)W * H;
			const long drawn = mask.Count(0, 0, W, H);
			const bool made = W * 9 == H * 16 && H == 360 * u;
			const int boxLimit = made && !Same(scene, "ending") ? 40 : 70, drawnLimit = made ? 30 : 40; // thousandths of the screen
			if (boxes * 1000 >= screen * boxLimit || drawn * 1000 >= screen * drawnLimit)
				printf("  %s at %dx%d: the corners' boxes are %.2f%% of the screen, the pixels drawn %.2f%%\n", scene, W, H, 100.0 * boxes / screen,
					100.0 * drawn / screen);
			CHECK(boxes * 1000 < screen * boxLimit);
			CHECK(drawn * 1000 < screen * drawnLimit);
			if (Same(scene, "racing") && W == 1280)
				printf("racing at %dx%d: place %dx%d, clocks %dx%d, map %dx%d, speed %dx%d, notes %dx%d; boxes %.2f%% of the screen, drawn %.2f%%\n", W, H,
					place.x1 - place.x0, place.y1 - place.y0, clocks.x1 - clocks.x0, clocks.y1 - clocks.y0, mini.x1 - mini.x0, mini.y1 - mini.y0,
					speed.x1 - speed.x0, speed.y1 - speed.y0, notes.x1 - notes.x0, notes.y1 - notes.y0, 100.0 * boxes / screen, 100.0 * drawn / screen);
		}
	}
}

int main(int argc, char** argv)
{
	MapData map;
	bool real = false;
	if (argc > 2)
	{
		real = LoadMap(argv[2], map);
		if (!real)
		{
			printf("FAILED: %s has no race_waypoint line\n", argv[2]);
			return 1;
		}
		printf("%s: %d waypoints, %d checkpoints\n", argv[2], (int)map.line.size(), (int)map.cps.size());
	}
	else
		Oval(map);

	CheckText();
	CheckClock();
	CheckLamps();
	CheckMap();
	CheckGauge();
	CheckProtocol();
	CheckLife();
	CheckLayout(map);
	CheckRallyNumbers();
	CheckRallyLayout();
	CheckRallyCountdown();
	CheckRallyPaint(map);
	CheckRallyContent(map);

	if (argc > 1)
	{
		static const int sizes[][2] = {{1280, 720}, {1920, 1080}, {1024, 768}};
		const float now = 500;
		for (const auto& size : sizes)
		{
			for (int snow = 0; snow < 2; snow++)
			for (const char* scene : kScenes)
			{
				Model m;
				Scene(scene, m, map, now);
				Picture pic(size[0], size[1], snow != 0);
				Painter painter(pic, m, now + (Same(scene, "wrongway") ? 0.1f : 0.0f));
				painter.Paint();
				char name[160];
				snprintf(name, sizeof(name), "%s/racehud-%s%s-%dx%d.png", argv[1], snow ? "snow-" : "", scene, size[0], size[1]);
				if (!WritePng(name, pic))
				{
					printf("FAILED: cannot write %s\n", name);
					g_failed++;
				}
				else
					printf("%s  (%d rectangles)\n", name, painter.rects);
			}
		}
	}

	if (argc > 1)
	{
		// rally mode: HL Rally's HUD, with a stand-in for each sprite (a grey box where the game draws the dial, the map's picture and the needle)
		static const int sizes[][2] = {{640, 480}, {1280, 720}, {1920, 1080}};
		const float now = 500;
		for (const auto& size : sizes)
		{
			for (int variant = 0; variant < 4; variant++)
			{
				Model m;
				RallyModel rm;
				RallyModelOn(m, rm, map, now);
				m.state = RACE_RACING;
				m.t0 = m.raceStart = now - 83.45f;
				m.lapStart = now - 41.2f;
				if (variant == 3)
				{
					m.lapStart = now - 2.0f;
					rm.lastLapCs = 4100;
				}
				rm.third = variant != 1;
				rm.mapSprite = variant == 2 || variant == 3;
				rm.speed3d = 3 * 142.0f;
				rm.gear = 3;
				Picture pic(size[0], size[1], false);
				const RallyLayout l = RallyLayoutFor(size[0], size[1]);
				pic.Fill(l.dialsX, l.dialsY, 225, 233, 120, 120, 130, 90); // the dial's sprite
				if (rm.mapSprite)
					pic.Fill(l.mapX, l.mapY, 128, 128, 60, 110, 60, 140); // the map's picture
				RallyModel keep = rm;
				RallyPainter painter(pic, m, keep, now);
				painter.Paint();
				if (rm.third)
				{
					float q[4][2];
					NeedleQuad(size[0], size[1], 140.0f, q); // the needle: from the centre to the middle of the quad's left edge
					painter.Line(l.needleX, l.needleY, (int)((q[0][0] + q[1][0]) / 2), (int)((q[0][1] + q[1][1]) / 2), 2, RH_RED, 255);
				}
				char name[160];
				snprintf(name, sizeof(name), "%s/racehud-rally-%s-%dx%d.png", argv[1], variant == 0 ? "chase" : (variant == 1 ? "interior" : (variant == 2 ? "map" : "lastlap")), size[0], size[1]);
				if (!WritePng(name, pic))
				{
					printf("FAILED: cannot write %s\n", name);
					g_failed++;
				}
				else
					printf("%s  (%d rectangles)\n", name, painter.rects);
			}
		}
	}

	if (g_failed)
		printf("FAIL: %d of %d checks\n", g_failed, g_checked);
	else
		printf("PASS: %d checks\n", g_checked);
	return g_failed ? 1 : 0;
}
