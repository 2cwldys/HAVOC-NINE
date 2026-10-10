#include <amxmodx>
#include <amxmisc>
#include <engine>
#include <fakemeta>
#include <easy_http>
#include <fun>
#include <tsx>


new apikey[128]

public plugin_init() {
    register_plugin("Competitive TS", "1.0", "xjiro");

    register_concmd("say /elo", "check_elo");
    register_concmd("say /rank", "check_elo");
    register_concmd("say !rank", "check_elo");
    register_concmd("say !elo", "check_elo");

    register_cvar("compts_apikey", "none");

    // Where to report to. Was hardcoded to the author's own server, which meant a
    // fresh install silently sent its players' kills somewhere else.
    register_cvar("compts_url", "http://127.0.0.1:8030");


    /*
     * The 'r' command is gone.
     *
     * It was a one-letter admin command that ran changelevel on the current map --
     * a development shortcut, and far too easy to hit by accident on a live server.
     * forcespawn survives but at ADMIN_CFG, matching every admin command in
     * ts_matchmode rather than the lower ADMIN_KICK it had.
     */
    register_concmd("compts_forcespawn", "force_spawn", ADMIN_CFG);
}




/*
 * Precaches a player model only if it is actually installed.
 *
 * Precaching a path that does not exist is a FATAL Host_Error -- the server does
 * not log it and carry on, it closes. These two models ship with CompTS but there
 * is no guarantee they were copied in, and a ranking plugin must not be able to
 * take the server down over a cosmetic file.
 */
stock compts_precache_model(const name[]) {
    new path[128];
    formatex(path, charsmax(path), "models/player/%s/%s.mdl", name, name);

    if (!file_exists(path)) {
        log_amx("[CompTS] WARNING: model %s is not installed -- skipping precache.", path);
        return;
    }

    precache_model(path);
}

public plugin_precache() {
    /*
     * These are CompTS's own team models from its README's BLUE/YELLOW setup. They
     * are precached when present so that setup still works, but nothing here reads
     * mp_teamlist or mp_teammodels -- the plugin has no team logic at all -- so a
     * server running different teams (ts_matchmode's, for instance) is unaffected.
     */
    compts_precache_model("merc_blue");
    compts_precache_model("seal_yellow");
}


public check_elo(id, level, cid) {
    get_cvar_string("compts_apikey", apikey, 128);

    new authid[32]
    get_user_authid(id, authid, 32)

    new EzHttpOptions:options_id = ezhttp_create_options()
    ezhttp_option_set_header(options_id, "apikey", apikey)
    ezhttp_option_set_header(options_id, "steamid", authid)

    new url[160];
    get_cvar_string("compts_url", url, charsmax(url));
    format(url, charsmax(url), "%s/check_elo", url);

    ezhttp_get(url, "get_elo_complete", options_id)
}


public get_elo_complete(EzHttpRequest:request_id)
{
    if (ezhttp_get_error_code(request_id) != EZH_OK)
    {
        new error[64]
        ezhttp_get_error_message(request_id, error, charsmax(error))
        server_print("Response error: %s", error);
        return
    }

    new data[512]
    ezhttp_get_data(request_id, data, charsmax(data))

    // split the data by ':' where the first half is steamid and the second half is the score
    new steamid[32], score[32], rank[32], name[64]
    parse(data, steamid, 32, score, 32, rank, 32)


    // find the user by steamid
    for(new i=0;i<32;i++)
    {
        if(!is_user_connected(i))
            continue

        new authid[32]
        get_user_authid(i, authid, 32)
        if(equali(steamid, authid))
        {
            get_user_name(i, name, 64)
            client_print(0, print_chat, "[CompTS] %s: Rank #%s (%s elo)", name, rank, score)
            break
        }
    }
}


public client_connect(id) {
    check_elo(id, 0, 0);
}


public client_death(killer,victim,wpnindex,hitplace,TK) {
    if(killer==victim)
        return;

    if (!(is_user_connected(killer) && is_user_connected(victim)))
        return;

    new headshot[4]
    num_to_str(hitplace == 1 ? 1 : 0, headshot, 4);
        
    new killer_steamid[32], victim_steamid[32];
    get_user_authid(killer, killer_steamid, 32);
    get_user_authid(victim, victim_steamid, 32);

    new EzHttpOptions:options_id = ezhttp_create_options()
    ezhttp_option_set_header(options_id, "apikey", apikey)
    ezhttp_option_set_header(options_id, "killer", killer_steamid)
    ezhttp_option_set_header(options_id, "victim", victim_steamid)
    ezhttp_option_set_header(options_id, "headshot", headshot)

    new url[160];
    get_cvar_string("compts_url", url, charsmax(url));
    format(url, charsmax(url), "%s/report/kill", url);

    ezhttp_post(url, "report_kill_copmlete", options_id)    
}

public report_kill_copmlete(EzHttpRequest:request_id) {
}


public force_spawn(id, level, cid) {
    if (!cmd_access(id, level, cid, 2))
        return PLUGIN_HANDLED;

    new arg[32];
    read_argv(1, arg, 31);
    new player = cmd_target(id, arg, CMDTARGET_ALLOW_SELF);
    
    if (!player)
        return PLUGIN_HANDLED;

    spawn(player);

    return PLUGIN_HANDLED;
}
