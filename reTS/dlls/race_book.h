/***
*  race_book.h -- the bookkeeping of a race (H9; h9-maps maps/race01/FINAL.md, task C1).
*
*  Plain C++ with no engine call, so that it is tested alone (dlls/tests/race_test.cpp). race.cpp feeds it what
*  it sees in the map (who entered which checkpoint, how far each racer is from his next one) and reads back
*  laps, times and places.
*
*  Checkpoints are numbered 0..count-1. Number 0 is the start and finish line; a lap is 1, 2, .. count-1, then 0.
*  The grid stands behind the line, so the first thing a racer does is cross 0: that crossing starts nothing and
*  counts nothing (the clock runs from the green light). A checkpoint entered out of order is ignored; the one
*  passed last, entered again, means he drives the wrong way.
***/
#pragma once

enum RaceEvent
{
	RACE_EV_NONE = 0,   // not a racer, or already finished, or no race
	RACE_EV_START,      // the line, crossed off the grid: nothing counted
	RACE_EV_CHECKPOINT, // the next checkpoint, in order
	RACE_EV_LAP,        // the line, closing a lap that is not the last
	RACE_EV_FINISH,     // the line, closing the last lap
	RACE_EV_IGNORED,    // a checkpoint out of order
	RACE_EV_WRONGWAY,   // the checkpoint passed last, entered again
};

const int RACE_MAX_RACERS = 32;
const int RACE_MAX_CHECKPOINTS = 64;
const float RACE_AWAY_SECONDS = 2.0f; // moving away from the next checkpoint this long is the wrong way
const float RACE_AWAY_SPEED = 60.0f;  // slower than this (units a second) is neither towards nor away

struct RaceRacer
{
	bool used = false;
	int id = 0;            // the caller's own number for him (a player's entity index)
	int lap = 0;           // laps closed
	int next = 0;          // the checkpoint he must enter next
	int last = -1;         // the checkpoint he passed last; -1 before the first
	int passed = 0;        // checkpoints counted since the start, over all laps
	bool offGrid = false;  // he has crossed the line off the grid
	bool finished = false;
	bool retired = false;  // out of time
	int place = 0;         // 1 = first, kept up by Rank()
	int finishPlace = 0;   // the order he finished in, 0 until then
	float lapStart = 0;    // when his lap began
	float lastLap = 0;     // his last closed lap, seconds; 0 with none
	float bestLap = 0;     // his best; 0 with none
	float total = 0;       // from the green light to his finish
	float split = 0;       // this lap's time at the checkpoint passed last
	float splitDiff = 0;   // against his best lap at the same checkpoint
	bool hasSplitDiff = false;
	float bonus = 0;       // seconds the checkpoints gave him
	float distance = 0;    // to the centre of his next checkpoint
	bool hasDistance = false;
	float away = 0;        // seconds he has moved away from it
	bool wrongWay = false;
	float splits[RACE_MAX_CHECKPOINTS] = {};     // this lap
	float bestSplits[RACE_MAX_CHECKPOINTS] = {}; // his best lap
};

class RaceBook
{
public:
	// Before a race: how many checkpoints the map has (the line included) and how many laps are driven.
	void Configure(int checkpoints, int laps);
	// The green light: every racer back to nothing, the clocks from `now`.
	void Start(float now);
	bool Running() const { return m_running; }
	void Stop() { m_running = false; }

	// A racer joins (false with no room) or leaves. Joining twice changes nothing.
	bool Add(int id);
	void Remove(int id);
	void Clear();

	// The racer entered a checkpoint (the caller tells entering from staying inside). `bonus`: seconds the
	// checkpoint gives when it counts.
	RaceEvent Enter(int id, int checkpoint, float now, float bonus = 0);
	// How far he is from the centre of his next checkpoint, each frame: keeps the wrong-way watch.
	void Progress(int id, float distance, float dt);
	// A racer put back on the track (a respawn): the wrong-way watch begins again.
	void Placed(int id);
	// Out of time: he races no further and is placed after those who finish.
	void Retire(int id);
	// Works out every racer's place: the finished in their order, then by laps, checkpoints, and distance left.
	void Rank();

	const RaceRacer* Find(int id) const;
	int Count() const;          // racers
	int FinishedCount() const;
	int StillRacing() const;    // neither finished nor retired
	int Laps() const { return m_laps; }
	int Checkpoints() const { return m_checkpoints; }
	float StartTime() const { return m_start; }
	// The racers in the order of their places (after Rank); returns how many it wrote.
	int Order(const RaceRacer** out, int max) const;

private:
	RaceRacer* Slot(int id);
	static bool Ahead(const RaceRacer& a, const RaceRacer& b);

	RaceRacer m_racers[RACE_MAX_RACERS];
	int m_checkpoints = 1;
	int m_laps = 1;
	int m_finishers = 0;
	float m_start = 0;
	bool m_running = false;
};

// Whether the straight move from `from` to `to` passes through the box (or ends or begins in it). A car that
// covers 90 units a frame cannot jump a trigger 16 thick this way.
bool RaceSegmentInBox(const float from[3], const float to[3], const float mins[3], const float maxs[3]);
