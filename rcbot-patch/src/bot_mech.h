// The Mech's two weapons, the M60 and the rocket launcher (rcbot-patch CHANGE 13). A Mech bot alternates between them in a
// fight. This file is the part that needs no engine: what a bot knows of the two weapons from the game's own messages, the
// rule that picks the weapon from the situation, and the small calculations the shooting uses. It includes nothing of the
// HL SDK or of CBot, so it can be tested on its own (rcbot-patch\test\test_bot_mech.cpp). bot.cpp (MECH WEAPONS, over
// CBot::MechPlay) fills the situation in from the world, sends the weapon-select command and presses the trigger.
//
// Weapons are the game's own numbers: TS weapon 32 is the M60, H9's weapon 41 is the Mech rocket launcher (reTS
// ts_mechrocket.cpp). Time is in seconds, distances in map units.
#ifndef BOT_MECH_H
#define BOT_MECH_H

#include <algorithm>
#include <cmath>

namespace mech
{
	constexpr int WPN_M60 = 32;       // a Mech sees it as a minigun
	constexpr int WPN_LAUNCHER = 41;  // one press launches a salvo of rockets, then the launcher waits h9_mechrocket_rate
	constexpr float LONG_AGO = -1.0e9f;

	// What a bot knows of its arsenal. It is fed by three user messages of the game library and by nothing else, so it does
	// not depend on any plugin:
	//   WStatus     (type, owned, clip)              sent for a weapon type whenever the player starts or stops owning it
	//   WeaponInfo  (type, clip, reserve, ...)       sent when the wielded type or its caliber's reserve changes
	//   ResetHUD                                     sent at every respawn, before WStatus announces the new life's weapons again
	// ClipInfo is registered by the game library and never sent, so a launcher's clip is worked out here from what the
	// bot did (a pull empties it) and corrected by every WeaponInfo while the launcher is in hand.
	struct State
	{
		bool own60 = false;           // the M60 is in the arsenal
		bool ownRl = false;           // and the launcher
		int clipRl = -1;              // rounds in the launcher, -1 when not known (counted as loaded)
		int reserveRl = -1;           // spare rounds of its caliber at the last WeaponInfo, -1 when not known
		int wielded = -1;             // type in hand at the last WeaponInfo, -1 since the last ResetHUD
		float wieldedAt = LONG_AGO;   // when the type in hand last changed

		// the weapon-select command in flight
		int pending = 0;              // the type asked for, 0 for none
		float pendingAt = 0.0f;
		float lastSwitch = LONG_AGO;  // when the last command went out
		float dwell = 3.0f;           // the dwell the next voluntary switch has to wait out, jitter included

		// the launcher's own clock
		float lastPull = LONG_AGO;    // when the trigger was last pressed on it
		float nextPull = 0.0f;        // the earliest next press
		float refusedUntil = 0.0f;    // it is left alone until then (refused, or a pull launched nothing)
		int dud = 0;                  // pulls in a row that launched no rocket
		bool watching = false;        // the rocket of the last pull is still being looked for
		float seenTarget = LONG_AGO;  // when a target was last in sight
		float farSince = LONG_AGO;    // since when the target has been far enough and in clear sight for a rocket

		// kept between two looks
		bool announced = false;       // the log has said this life that the bot is a Mech
		float nextLook = 0.0f;        // the situation is worked out this often, not every frame
		int group = 1;                // enemies within a blast of the target at the last count
		float groupAt = LONG_AGO;     // and when that was
		int lastWhy = -1;             // what the rule answered at the last look, for the debug line
		int lastPick = 0;

		void reset()
		{
			*this = State();
		}

		// The game's clock starts again at each map: a time kept from the map before is not in the future of this one.
		void fixClocks(const float now)
		{
			if (lastSwitch > now || lastPull > now || wieldedAt > now || pendingAt > now || seenTarget > now || farSince > now ||
				groupAt > now || nextLook > now + 5.0f || nextPull > now + 30.0f || refusedUntil > now + 600.0f)
			{
				lastSwitch = lastPull = wieldedAt = seenTarget = farSince = groupAt = LONG_AGO;
				pendingAt = nextLook = nextPull = refusedUntil = 0.0f;
				pending = 0;
				watching = false;
			}
		}

		bool isMech() const
		{
			return own60 && ownRl;
		}

		// WStatus: the arsenal gained or lost a weapon type.
		void onWStatus(const int type, const int owned, const int clip)
		{
			if (type == WPN_M60)
			{
				own60 = owned != 0;

				if (!own60 && wielded == WPN_M60)
					wielded = -1;
			}
			else if (type == WPN_LAUNCHER)
			{
				ownRl = owned != 0;

				if (ownRl)
				{
					clipRl = clip;
				}
				else
				{
					clipRl = -1;
					reserveRl = -1;

					if (wielded == WPN_LAUNCHER)
						wielded = -1;
				}
			}
		}

		// WeaponInfo: the game says which type is in hand, and with the launcher in hand how full it is.
		void onWeaponInfo(const int type, const int clip, const int reserve, const float now)
		{
			if (type != wielded)
				wieldedAt = now;

			wielded = type;

			if (pending != 0 && type == pending)
				pending = 0;

			if (type == WPN_M60)
			{
				own60 = true;
			}
			else if (type == WPN_LAUNCHER)
			{
				ownRl = true;
				clipRl = clip;
				reserveRl = reserve;
			}
		}

		// ResetHUD: a new life. The weapons are announced again right after it.
		void onResetHUD()
		{
			reset();
		}

		// The clip and the spare rounds are told to the bot only with the launcher in hand, and a reload or a resupply is told to nobody
		// else: what has gone stale is counted as not known again, and the next look at the launcher says. A launcher in hand that
		// has been empty for longer than any reload takes counts as loaded; one that was spent counts as maybe filled again.
		void ageClip(const float now, const float reloadAssume, const float spentRecheck)
		{
			const float out = std::max(lastPull, wieldedAt);

			if (wielded == WPN_LAUNCHER && clipRl == 0 && reserveRl != 0 && now - out > reloadAssume)
				clipRl = -1;

			if (clipRl == 0 && reserveRl == 0 && now - lastPull > spentRecheck)
				reserveRl = -1;
		}

		// Whether the trigger may be pressed on the launcher now: it is in hand and drawn, past its own delay, not refused, and not
		// known to be empty. The caller adds what only the world can say (a target, a line, an aim).
		bool mayPull(const float now, const float deploy) const
		{
			return pending == 0 && wielded == WPN_LAUNCHER && now >= nextPull && now >= wieldedAt + deploy && refusedUntil <= now &&
				clipRl != 0;
		}

		// A pull of the trigger on the launcher: it emptied what a salvo takes from the clip.
		void onPull(const float now, const int salvo, const int defaultClip, const float cooldown)
		{
			const int had = clipRl >= 0 ? clipRl : defaultClip;

			clipRl = std::max(0, had - std::max(1, salvo));
			lastPull = now;
			nextPull = now + cooldown;
			watching = true;
		}
	};

	// The numbers the rule works with. Defaults are the shipped ones; bot.cpp overrides what a cvar sets.
	struct Tuning
	{
		float dwell = 3.0f;           // tsm_bot_mech_dwell: the least seconds between two switches the bot chose itself
		float dwellJitter = 0.5f;     // up to this share of the dwell is added at random, a different one for each switch
		float minFire = 400.0f;       // tsm_bot_mech_near: the nearest target a launcher is pulled at
		float farFactor = 1.35f;      // the M60 is put away for the launcher only beyond minFire times this
		float urgentFactor = 0.75f;   // closer than minFire times this and the launcher goes away at once
		float maxFire = 1800.0f;      // the farthest target
		float suppressRange = 1500.0f; // within it the M60 takes over from an emptied launcher; beyond it the bot waits out the reload
		float groupFactor = 0.7f;     // a group of two or more lowers minFire to this share
		float floorFire = 256.0f;     // and never below this
		float reloadWait = 8.0f;      // the longest it waits on an empty launcher in hand for the game's auto reload (bot.cpp: from the cvars)
		float reloadAssume = 7.0f;    // after this long an empty launcher is counted as loaded, and the next pull tells (the same)
		float spentRecheck = 90.0f;   // a spent launcher is counted as maybe filled again (a resupply) this long after its last pull
		float calm = 2.0f;            // seconds with no target before it takes an empty launcher out to reload it
		float rest = 1.0f;            // seconds with no target before it puts a loaded one away
		float settle = 0.5f;          // the target must have been far enough and in clear sight this long before the launcher comes out
		float forcedDwell = 2.0f;     // after a switch the situation forced, the dwell is this many times as long
		float cmdGap = 0.6f;          // the least between two weapon-select commands whatever the reason
		float switchWait = 1.5f;      // a command is counted refused when the game says nothing in this time
		float deploy = 1.0f;          // after a launcher comes out, before the first pull
		float refusal = 20.0f;        // how long a refused launcher is left alone
	};

	enum Pick
	{
		KEEP = 0,
		TO_M60,
		TO_LAUNCHER
	};

	// Why the rule answered as it did (the debug line prints it).
	enum Why
	{
		W_NONE = 0,
		W_NOT_MECH,
		W_PENDING,
		W_SALVO,
		W_DWELL,
		W_SETTLING,
		W_FAR_CLEAR,
		W_GROUP,
		W_NEAR,
		W_NO_LINE,
		W_BAD_TARGET,
		W_EMPTY,
		W_SPENT,
		W_REFUSED,
		W_RELOADING,
		W_RELOAD_IN_PEACE,
		W_BACK_TO_M60,
		W_WRONG_HAND,
		W_HOLD
	};

	struct Decision
	{
		Pick pick = KEEP;
		Why why = W_NONE;
		bool forced = false;          // the situation forced the switch: it did not wait for the dwell
	};

	inline const char* whyName(const Why w)
	{
		switch (w)
		{
		case W_NOT_MECH: return "not a mech";
		case W_PENDING: return "switch in flight";
		case W_SALVO: return "salvo leaving";
		case W_DWELL: return "dwell";
		case W_SETTLING: return "target not steady yet";
		case W_FAR_CLEAR: return "far target, clear line";
		case W_GROUP: return "group, clear line";
		case W_NEAR: return "target too near";
		case W_NO_LINE: return "no clear line or out of range";
		case W_BAD_TARGET: return "target is not for rockets";
		case W_EMPTY: return "launcher empty";
		case W_SPENT: return "launcher spent";
		case W_REFUSED: return "launcher refused";
		case W_RELOADING: return "launcher reloading";
		case W_RELOAD_IN_PEACE: return "reload in peace";
		case W_BACK_TO_M60: return "back to the m60";
		case W_WRONG_HAND: return "neither weapon in hand";
		case W_HOLD: return "hold";
		default: return "";
		}
	}

	// The situation, as bot.cpp finds it.
	struct Look
	{
		// the arsenal and the clocks
		bool own60 = false;
		bool ownRl = false;
		int wielded = -1;
		int clipRl = -1;
		int reserveRl = -1;
		bool refused = false;         // the launcher is left alone for now
		bool pending = false;         // a weapon-select command is in flight
		float sinceSwitch = 0.0f;     // seconds since the last command
		float dwell = 3.0f;           // the dwell it has to have waited out
		float sincePull = 1.0e9f;     // seconds since the last pull
		float sinceOut = 1.0e9f;      // seconds since the launcher was last pulled or came out, as far as a reload goes
		bool afterPull = false;       // the launcher was emptied by a pull since it came out (and not before it)
		float salvoTime = 0.5f;       // seconds a salvo takes to leave

		// the fight
		bool target = false;          // an enemy in sight
		bool fit = true;              // a player or a turret: a rocket is for those, not for a door
		float dist = 0.0f;            // from the gun to the aim point
		float need = 400.0f;          // the nearest target a pull is for (fireRange, worked out for this target)
		bool clear = false;           // a rocket flies the line to the target
		float farFor = 0.0f;          // seconds the target has been far enough and in clear sight, 0 when it is not
		int group = 1;                // enemies within a blast of the target, the target included
		float sinceTarget = 1.0e9f;   // seconds since a target was in sight, 0 when one is
	};

	// The nearest target a launcher is pulled at: minFire, lowered for a group, and raised so that the blast of a rocket
	// cannot reach the one who fires it when the game lets it hurt him (h9_mechrocket_selfdamage 1).
	inline float fireRange(const Tuning& t, const float radius, const bool selfDamage, const bool group)
	{
		float range = t.minFire;

		if (group)
			range = std::max(t.floorFire, range * t.groupFactor);

		if (selfDamage)
			range = std::max(range, radius * 1.4f);

		return std::max(range, 1.0f);
	}

	// Whether the target is one for the launcher to come out for: a player or a turret, in clear sight of a rocket, beyond the pull line
	// by the margin that keeps the launcher from going in and out, and not too far.
	inline bool farEnough(const Tuning& t, const Look& l)
	{
		return l.target && l.fit && l.clear && l.dist >= std::max(l.need, 1.0f) * t.farFactor && l.dist <= t.maxFire;
	}

	// The rule. It looks at the situation and answers with the weapon the bot should have in hand. KEEP is "the one it has".
	// A voluntary switch waits out the dwell; one the situation forces (an empty or refused launcher, a target at its feet)
	// does not. The caller keeps its own floor, Tuning::cmdGap, between two commands.
	inline Decision decide(const Tuning& t, const Look& l)
	{
		Decision d;

		if (!l.own60 || !l.ownRl)
		{
			d.why = W_NOT_MECH;
			return d;
		}

		if (l.pending)
		{
			d.why = W_PENDING;
			return d;
		}

		const bool inHand = l.wielded == WPN_LAUNCHER;
		const bool m60InHand = l.wielded == WPN_M60;
		const bool unknown = l.wielded < 0;
		const bool loaded = l.clipRl != 0;
		const bool spent = l.clipRl == 0 && l.reserveRl == 0;
		const bool reloading = l.clipRl == 0 && !spent;
		const bool usable = loaded && !l.refused;
		const bool dwelled = l.sinceSwitch >= l.dwell;
		const float need = std::max(l.need, 1.0f);

		// a salvo that is still leaving is not interrupted
		if (inHand && l.sincePull < l.salvoTime)
		{
			d.why = W_SALVO;
			return d;
		}

		if (l.target)
		{
			if (inHand)
			{
				if (l.refused)
				{
					d.pick = TO_M60;
					d.why = W_REFUSED;
					d.forced = true;
				}
				else if (spent)
				{
					d.pick = TO_M60;
					d.why = W_SPENT;
					d.forced = true;
				}
				else if (!l.fit)
				{
					d.pick = TO_M60;
					d.why = W_BAD_TARGET;
					d.forced = true;
				}
				else if (l.dist < need * t.urgentFactor)
				{
					d.pick = TO_M60;
					d.why = W_NEAR;
					d.forced = true;
				}
				else if (reloading)
				{
					// An emptied launcher is left to the M60 while the target is within its reach. The game reloads a dry clip only
					// while the launcher is in hand, so a launcher that came out to reload, or a target too far for the M60, is
					// waited on: a switch would throw the reload away. A target inside the pull line, or one no rocket flies to, is no
					// one to wait for.
					if (l.dist < need || !l.clear)
					{
						d.pick = TO_M60;
						d.why = l.dist < need ? W_NEAR : W_NO_LINE;
						d.forced = true;
					}
					else if (l.afterPull && l.dist <= t.suppressRange)
					{
						d.pick = TO_M60;
						d.why = W_EMPTY;
						d.forced = true;
					}
					else if (l.sinceOut < t.reloadWait)
					{
						d.why = W_RELOADING;
					}
					else
					{
						d.pick = TO_M60;
						d.why = W_EMPTY;
						d.forced = true;
					}
				}
				else if (l.dist < need || !l.clear || l.dist > t.maxFire)
				{
					if (dwelled)
					{
						d.pick = TO_M60;
						d.why = l.dist < need ? W_NEAR : W_NO_LINE;
					}
					else
					{
						d.why = W_DWELL;
					}
				}
				else
				{
					d.why = W_HOLD;
				}

				return d;
			}

			// the M60, or something else, in hand; before the first WeaponInfo of a life nobody knows what is in hand
			if (unknown)
			{
				d.why = W_HOLD;
				return d;
			}

			if (!usable)
			{
				if (!m60InHand)
				{
					d.pick = TO_M60;
					d.why = W_WRONG_HAND;
					d.forced = true;
				}
				else
				{
					d.why = l.refused ? W_REFUSED : (spent ? W_SPENT : W_EMPTY);
				}

				return d;
			}

			if (!dwelled && m60InHand)
			{
				d.why = W_DWELL;
				return d;
			}

			if (farEnough(t, l))
			{
				if (l.farFor < t.settle)
				{
					d.why = W_SETTLING;
					return d;
				}

				d.pick = TO_LAUNCHER;
				d.why = l.group >= 2 ? W_GROUP : W_FAR_CLEAR;
				return d;
			}

			if (!m60InHand)
			{
				d.pick = TO_M60;
				d.why = W_WRONG_HAND;
				d.forced = true;
				return d;
			}

			d.why = W_HOLD;
			return d;
		}

		// nothing in sight
		if (inHand)
		{
			if (reloading && !l.refused)
			{
				d.why = W_RELOADING;
			}
			else if (l.sinceTarget >= t.rest && l.sinceSwitch >= std::min(l.dwell, 1.0f))
			{
				d.pick = TO_M60;
				d.why = W_BACK_TO_M60;
			}
			else
			{
				d.why = W_HOLD;
			}

			return d;
		}

		if (reloading && !l.refused && m60InHand && l.sinceTarget >= t.calm && dwelled)
		{
			d.pick = TO_LAUNCHER;
			d.why = W_RELOAD_IN_PEACE;
			return d;
		}

		d.why = W_HOLD;
		return d;
	}

	// The distance within which a shot lands close enough to the aim point to count: a share of the blast radius.
	inline float aimTolerance(const float radius)
	{
		return std::max(48.0f, 0.4f * std::max(radius, 1.0f));
	}

	// Seconds a rocket flies to a target `dist` away, capped: the lead is that long a walk of the target.
	inline float leadTime(const float dist, const float speed, const float cap)
	{
		const float s = std::min(std::max(speed, 100.0f), 4000.0f);

		return std::min(std::max(dist, 0.0f) / s, cap);
	}

	// Seconds a salvo of n rockets takes to leave, n - 1 gaps apart, plus a margin for the frame it starts in.
	inline float salvoTime(const int salvo, const float stagger)
	{
		const int n = std::min(std::max(salvo, 1), 8);

		return std::max(n - 1, 0) * std::max(stagger, 0.0f) + 0.35f;
	}

	// Seconds from the first rocket of a pull to the next pull the launcher takes: the gaps of the salvo, then the launcher's own delay
	// (h9_mechrocket_rate counts from the salvo's last rocket), and a margin for the frame it falls in.
	inline float pullCooldown(const float rate, const int salvo, const float stagger)
	{
		const int n = std::min(std::max(salvo, 1), 8);

		return std::max(n - 1, 0) * std::max(stagger, 0.0f) + std::max(rate, 0.1f) + 0.2f;
	}

	// The game starts the reload of a dry clip once the launcher in hand has been idle: 2 s after its last rocket (CTSGun::MechRocketShot
	// sets the idle timer), 3 s after it was drawn (CBasePlayerWeapon::DefaultDeploy). A dry launcher that is put away is not reloaded.
	// The reload then takes h9_mechrocket_reload. The longer idle is the one used here.
	constexpr float AUTO_RELOAD_IDLE = 3.0f;

	// Seconds from the game's idle start to a loaded launcher that stayed in hand: the idle wait and the reload.
	inline float reloadSeconds(const float reload)
	{
		return AUTO_RELOAD_IDLE + std::min(std::max(reload, 0.5f), 30.0f);
	}
}

#endif // BOT_MECH_H
