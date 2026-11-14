// Checks the race HUD's arithmetic (h9_racehud_draw.h: the clocks' text, the clock's offset, the start lights, the map's fit, the
// gauge) and its layout (nothing off the screen, no part over another) with no game, and, given a folder, draws the HUD into PNG
// pictures there with the very Painter the game draws with, over a canvas that is a picture in memory:
//   cmake --build <dir> --target racehud_test --config Release
//   racehud_test [<folder for the pictures> [<a .map with race_waypoint and race_checkpoint entities>]]
// With no map the pictures have a made-up oval for a lap.
#include "../h9_racehud_draw.h"

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

// A picture in memory: what the game's screen would show, over a made-up night scene.
struct Picture : Canvas
{
	int w, h;
	std::vector<unsigned char> rgb;
	Picture(int W, int H) : w(W), h(H), rgb((size_t)W * H * 3)
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
	CHECK(RACE_MSG_STAT_SIZE == 6 + 2 + 1 + 2 + 4 * 4 + 2 * 4);
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

// Every scene at every size: nothing leaves the screen, and no part stands on another.
static void CheckLayout(const MapData& map)
{
	static const int sizes[][2] = {{1280, 720}, {1920, 1080}, {1024, 768}, {800, 600}, {640, 480}, {1600, 900}, {2560, 1440}, {1280, 1024}, {3440, 1440}, {1366, 768}, {1440, 900}};
	const float now = 500;
	for (const auto& size : sizes)
	{
		for (const char* scene : kScenes)
		{
			Model m;
			Scene(scene, m, map, now);
			Bounds whole(size[0], size[1]);
			Painter all(whole, m, now);
			all.Paint();
			if (whole.outside || whole.Empty())
				printf("  %s at %dx%d: %s\n", scene, size[0], size[1], whole.Empty() ? "nothing drawn" : "drawn off the screen");
			CHECK(!whole.outside);
			CHECK(!whole.Empty());
			if (Same(scene, "results"))
				continue;
			Bounds panel(size[0], size[1]), speed(size[0], size[1]), mini(size[0], size[1]), board(size[0], size[1]), lights(size[0], size[1]),
				notes(size[0], size[1]);
			Painter(panel, m, now).RacePanel();
			Painter(speed, m, now).Speed();
			Painter(mini, m, now).Minimap();
			Painter(board, m, now).Board();
			Painter(lights, m, now).StartLights();
			Painter(notes, m, now + 0.1f).Notes(); // a moment when "wrong way" is lit
			CHECK(mini.Empty() || mini.x1 == MapRight(size[0], size[1])); // the chat begins to the right of it (H9RaceHud_ChatLeft)
			const Bounds* parts[6] = {&panel, &speed, &mini, &board, &lights, &notes};
			static const char* const names[6] = {"the race panel", "the speed", "the map", "the board", "the lights", "the notes"};
			for (int i = 0; i < 6; i++)
				for (int k = i + 1; k < 6; k++)
				{
					if (!Apart(*parts[i], *parts[k]))
						printf("  %s at %dx%d: %s is over %s\n", scene, size[0], size[1], names[i], names[k]);
					CHECK(Apart(*parts[i], *parts[k]));
				}
			// TS's round timer (roundtime.cpp: at ScreenWidth - 72, 12, some 64 by 16 pixels) stays clear
			Bounds timer(size[0], size[1]);
			timer.Fill(size[0] - 72, 12, 64, 16, 0, 0, 0, 0);
			for (int i = 0; i < 6; i++)
				CHECK(Apart(*parts[i], timer));
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

	if (argc > 1)
	{
		static const int sizes[][2] = {{1280, 720}, {1920, 1080}, {1024, 768}};
		const float now = 500;
		for (const auto& size : sizes)
		{
			for (const char* scene : kScenes)
			{
				Model m;
				Scene(scene, m, map, now);
				Picture pic(size[0], size[1]);
				Painter painter(pic, m, now + (Same(scene, "wrongway") ? 0.1f : 0.0f));
				painter.Paint();
				char name[160];
				snprintf(name, sizeof(name), "%s/racehud-%s-%dx%d.png", argv[1], scene, size[0], size[1]);
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
