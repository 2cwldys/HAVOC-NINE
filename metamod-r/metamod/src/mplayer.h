#pragma once

// Info on an individual player
class MPlayer
{
public:
	MPlayer();

	void set_cvar_query(const char* cvar);				// mark this player as querying a client cvar
	void clear_cvar_query(const char* cvar = nullptr);	// unmark this player as querying a client cvar
	const char* is_querying_cvar() const;				// check if a player is querying a cvar. returns

private:
	bool m_isQueried;									// is this player currently queried for a cvar value
	char g_cvarName[64];								// name of the cvar if getting queried
};

// A list of players. The number of max players is fixed and small enough
// to use an array.
class MPlayerList
{
public:
	void set_player_cvar_query(const edict_t* pEntity, const char* cvar);
	void clear_player_cvar_query(const edict_t* pEntity, const char* cvar = nullptr);
	void clear_all_cvar_queries();
	const char* is_querying_cvar(const edict_t* pEntity) const;

private:
	// Every player slot a server can have: H9's engine and game DLLs are built for 128 (the
	// HLSDK's MAX_CLIENTS in const.h is 32). Every look-up is bounded by it as well as by
	// maxClients.
	enum { MAX_SLOTS = 128 };
	MPlayer m_players[MAX_SLOTS + 1]; // array of players
};
