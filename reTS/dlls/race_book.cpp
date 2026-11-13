/***
*  race_book.cpp -- the bookkeeping of a race: see race_book.h. No engine call in this file.
***/
#include "race_book.h"

void RaceBook::Configure(int checkpoints, int laps)
{
	m_checkpoints = checkpoints < 1 ? 1 : (checkpoints > RACE_MAX_CHECKPOINTS ? RACE_MAX_CHECKPOINTS : checkpoints);
	m_laps = laps < 1 ? 1 : laps;
}

static void RaceResetRacer(RaceRacer& racer, int checkpoints, float now)
{
	const int id = racer.id;
	racer = RaceRacer();
	racer.used = true;
	racer.id = id;
	// with checkpoints besides the line, the first to count is 1; with the line alone, the line itself (after the
	// crossing off the grid)
	racer.next = checkpoints > 1 ? 1 : 0;
	racer.lapStart = now;
}

void RaceBook::Start(float now)
{
	m_start = now;
	m_finishers = 0;
	m_running = true;
	for (RaceRacer& racer : m_racers)
	{
		if (racer.used)
			RaceResetRacer(racer, m_checkpoints, now);
	}
	Rank();
}

RaceRacer* RaceBook::Slot(int id)
{
	for (RaceRacer& racer : m_racers)
	{
		if (racer.used && racer.id == id)
			return &racer;
	}
	return nullptr;
}

const RaceRacer* RaceBook::Find(int id) const
{
	return const_cast<RaceBook*>(this)->Slot(id);
}

bool RaceBook::Add(int id)
{
	if (Slot(id))
		return true;
	for (RaceRacer& racer : m_racers)
	{
		if (!racer.used)
		{
			racer.id = id;
			// one who joins a race under way starts it there and then, on the race's clock
			RaceResetRacer(racer, m_checkpoints, m_start);
			return true;
		}
	}
	return false;
}

void RaceBook::Remove(int id)
{
	RaceRacer* racer = Slot(id);
	if (racer)
		*racer = RaceRacer();
}

void RaceBook::Clear()
{
	for (RaceRacer& racer : m_racers)
		racer = RaceRacer();
	m_finishers = 0;
	m_running = false;
}

RaceEvent RaceBook::Enter(int id, int checkpoint, float now, float bonus)
{
	RaceRacer* racer = Slot(id);
	if (!m_running || !racer || racer->finished || racer->retired)
		return RACE_EV_NONE;
	if (checkpoint < 0 || checkpoint >= m_checkpoints)
		return RACE_EV_IGNORED;

	// the line, off the grid: before anything was counted
	if (checkpoint == 0 && racer->passed == 0 && !racer->offGrid)
	{
		racer->offGrid = true;
		return RACE_EV_START;
	}
	if (checkpoint != racer->next)
	{
		// the one he passed last, again (the line counts as passed once he is off the grid): he came back to it
		const int last = racer->last >= 0 ? racer->last : (racer->offGrid ? 0 : -1);
		if (checkpoint == last && m_checkpoints > 1)
		{
			racer->wrongWay = true;
			return RACE_EV_WRONGWAY;
		}
		return RACE_EV_IGNORED;
	}

	// in order: it counts
	racer->passed++;
	racer->last = checkpoint;
	racer->next = (checkpoint + 1) % m_checkpoints;
	racer->bonus += bonus;
	racer->away = 0;
	racer->wrongWay = false;
	racer->hasDistance = false; // the distance is to another checkpoint now
	racer->split = now - racer->lapStart;
	racer->splits[checkpoint] = racer->split;
	racer->hasSplitDiff = racer->bestLap > 0;
	racer->splitDiff = racer->hasSplitDiff ? racer->split - racer->bestSplits[checkpoint] : 0;
	if (checkpoint != 0)
		return RACE_EV_CHECKPOINT;

	// the line closes the lap
	racer->lap++;
	racer->lastLap = racer->split;
	if (racer->bestLap <= 0 || racer->lastLap < racer->bestLap)
	{
		racer->bestLap = racer->lastLap;
		for (int i = 0; i < m_checkpoints; i++)
			racer->bestSplits[i] = racer->splits[i];
	}
	racer->lapStart = now;
	if (racer->lap < m_laps)
		return RACE_EV_LAP;
	racer->finished = true;
	racer->total = now - m_start;
	racer->finishPlace = ++m_finishers;
	return RACE_EV_FINISH;
}

void RaceBook::Progress(int id, float distance, float dt)
{
	RaceRacer* racer = Slot(id);
	if (!m_running || !racer || racer->finished || racer->retired)
		return;
	if (racer->hasDistance && dt > 0)
	{
		const float speed = (distance - racer->distance) / dt; // positive: away
		if (speed > RACE_AWAY_SPEED)
			racer->away += dt;
		else if (speed < -RACE_AWAY_SPEED)
		{
			racer->away = 0;
			racer->wrongWay = false;
		}
		if (racer->away >= RACE_AWAY_SECONDS)
			racer->wrongWay = true;
	}
	racer->distance = distance;
	racer->hasDistance = true;
}

void RaceBook::Placed(int id)
{
	RaceRacer* racer = Slot(id);
	if (!racer)
		return;
	racer->away = 0;
	racer->wrongWay = false;
	racer->hasDistance = false;
}

void RaceBook::Retire(int id)
{
	RaceRacer* racer = Slot(id);
	if (racer && !racer->finished)
	{
		racer->retired = true;
		racer->wrongWay = false;
	}
}

// Whether a is placed before b.
bool RaceBook::Ahead(const RaceRacer& a, const RaceRacer& b)
{
	if (a.finished != b.finished)
		return a.finished;
	if (a.finished)
		return a.finishPlace < b.finishPlace;
	if (a.passed != b.passed) // laps first, then checkpoints: `passed` counts both
		return a.passed > b.passed;
	if (a.hasDistance != b.hasDistance)
		return a.hasDistance;
	if (a.distance != b.distance)
		return a.distance < b.distance;
	return a.id < b.id;
}

void RaceBook::Rank()
{
	for (RaceRacer& racer : m_racers)
	{
		if (!racer.used)
			continue;
		int place = 1;
		for (const RaceRacer& other : m_racers)
		{
			if (other.used && &other != &racer && Ahead(other, racer))
				place++;
		}
		racer.place = place;
	}
}

int RaceBook::Count() const
{
	int count = 0;
	for (const RaceRacer& racer : m_racers)
		count += racer.used ? 1 : 0;
	return count;
}

int RaceBook::FinishedCount() const
{
	int count = 0;
	for (const RaceRacer& racer : m_racers)
		count += racer.used && racer.finished ? 1 : 0;
	return count;
}

int RaceBook::StillRacing() const
{
	int count = 0;
	for (const RaceRacer& racer : m_racers)
		count += racer.used && !racer.finished && !racer.retired ? 1 : 0;
	return count;
}

int RaceBook::Order(const RaceRacer** out, int max) const
{
	int written = 0;
	for (int place = 1; place <= RACE_MAX_RACERS && written < max; place++)
	{
		for (const RaceRacer& racer : m_racers)
		{
			if (racer.used && racer.place == place && written < max)
				out[written++] = &racer;
		}
	}
	return written;
}

// The slab method: the part of the segment inside each pair of faces, and whether the three parts overlap.
bool RaceSegmentInBox(const float from[3], const float to[3], const float mins[3], const float maxs[3])
{
	float enter = 0, leave = 1;
	for (int axis = 0; axis < 3; axis++)
	{
		const float move = to[axis] - from[axis];
		if (move > -0.0001f && move < 0.0001f)
		{
			if (from[axis] < mins[axis] || from[axis] > maxs[axis])
				return false;
			continue;
		}
		float t0 = (mins[axis] - from[axis]) / move;
		float t1 = (maxs[axis] - from[axis]) / move;
		if (t0 > t1)
		{
			const float swap = t0;
			t0 = t1;
			t1 = swap;
		}
		if (t0 > enter)
			enter = t0;
		if (t1 < leave)
			leave = t1;
		if (enter > leave)
			return false;
	}
	return true;
}
