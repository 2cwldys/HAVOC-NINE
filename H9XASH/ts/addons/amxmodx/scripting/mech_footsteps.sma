/*
 * mech_footsteps.sma -- the two mech walk sounds (alternating) and the idle hum,
 * for the mech models.
 *
 * A GoldSrc player model cannot carry its own sound table (that arrived with
 * Source), so the model itself can never decide what its steps sound like. What
 * it can do is be recognised: every footstep the game plays is a sound event
 * naming one of the engine's stock player/pl_* samples, and a server plugin can
 * catch those, look at whose feet they came off, and hand out a different file
 * instead.
 *
 * So: whoever is wearing mech_msr_bot or mech_ins_bot gets mechwalk.wav on one
 * step, mechwalk2.wav on the next -- 1, 2, 1, 2 for as long as they walk.
 * Everyone else's steps are untouched, and so are the mech's own pain, death,
 * drowning, wading and ladder sounds: only footfalls are swapped.
 *
 * The two wavs live in ts\sound\ (build.bat syncs them there from sound\). A
 * precached name with no file behind it is a FATAL Host_Error on map load, not
 * a silent miss -- so the files must be in place before the server loads a map
 * with this plugin registered.
 *
 * The model match is by prefix, so the _bot names and any future worn variant
 * (a mech_msr_bot_soot and the like) stay covered without an edit here.
 *
 * The hum rides on the same model match: every living mech has mechloop.wav
 * re-emitted from it on a timer, so the sample hears as one continuous loop.
 * The wav is mono on purpose -- the engine ignores attenuation on stereo
 * samples, so a stereo loop would be heard map-wide at full volume instead of
 * fading with distance. It lives in ts\sound\ like the steps do.
 */

#include <amxmodx>
#include <fakemeta>
#include <hlsdk_const>

#define PLUGIN  "TS Mech Footsteps"
#define VERSION "1.1"
#define AUTHOR  "tsm"

// The step pair, in the order they alternate. precache_sound resolves these
// under sound\, so the files are ts\sound\mechwalk.wav and ts\sound\mechwalk2.wav.
new const g_step_sounds[][] = { "mechwalk.wav", "mechwalk2.wav" };

// The models that walk in them.
new const g_mech_prefixes[][] = { "mech_msr", "mech_ins" };

// The idle hum under every living mech. mechloop.wav is 2.250 s at 22050 Hz
// mono; it is re-emitted 50 ms before the sample ends, so the fresh pass cuts
// the old tail and the seam is never silent.
// LOOP_ATTEN is the mid-range falloff: ATTN_STATIC (1.25) is shorter,
// ATTN_IDLE (2.0) shorter still, ATTN_NONE (0) is heard map-wide.
#define LOOP_SOUND  "mechloop.wav"
#define LOOP_VOLUME 0.4
#define LOOP_ATTEN  ATTN_NORM
#define LOOP_PERIOD 2.2

// What the engine calls a footstep: pm_shared picks these by the floor texture
// (pl_step default, then pl_dirt, pl_metal, pl_grate, pl_tile, pl_duct, ...),
// all under the player/pl_ prefix. The prefix also covers a handful of sounds
// that are NOT steps, and those are turned away by name.
new const g_not_steps[][] = {
    "pain", "die", "drown", "swim", "wade", "water", "ladder", "breathe", "fall"
};

new g_next[33];   // per walker: which of the pair their next step plays

public plugin_precache() {
    for (new i = 0; i < sizeof g_step_sounds; i++)
        precache_sound(g_step_sounds[i]);
    precache_sound(LOOP_SOUND);
}

public plugin_init() {
    register_plugin(PLUGIN, VERSION, AUTHOR);
    register_forward(FM_EmitSound, "fw_emit_sound");
    set_task(LOOP_PERIOD, "task_mech_loop", 0, "", 0, "b");
}

// The model string is the full path, e.g. models/player/mech_msr_bot/mech_msr_bot.mdl
stock bool:wears_mech(id) {
    new model[64];
    pev(id, pev_model, model, charsmax(model));
    for (new i = 0; i < sizeof g_mech_prefixes; i++)
        if (containi(model, g_mech_prefixes[i]) != -1)
            return true;
    return false;
}

stock bool:is_footstep(const sample[]) {
    if (!equali(sample, "player/pl_", 9))
        return false;
    for (new i = 0; i < sizeof g_not_steps; i++)
        if (containi(sample, g_not_steps[i]) != -1)
            return false;
    return true;
}

public fw_emit_sound(id, channel, const sample[], Float:volume, Float:attenuation, flags, pitch) {
    if (id < 1 || id > get_maxplayers())
        return FMRES_IGNORED;            // a world sound, not a walker
    if (!is_user_alive(id) || !is_footstep(sample) || !wears_mech(id))
        return FMRES_IGNORED;

    // play this step from the pair, then turn the pair over for the next one
    emit_sound(id, channel, g_step_sounds[g_next[id]], volume, attenuation, flags, pitch);
    g_next[id] = (g_next[id] + 1) % sizeof g_step_sounds;
    return FMRES_SUPERCEDE;              // the stock step is never heard
}

// Every LOOP_PERIOD, hand the hum to everyone standing in range of a living
// mech. CHAN_STATIC so a weapon or voice from the same walker does not cut it;
// each pass replaces the last one on that channel, which is what makes the
// loop continuous. A mech that dies keeps at most one pass of tail.
public task_mech_loop() {
    for (new id = 1; id <= get_maxplayers(); id++) {
        if (!is_user_alive(id) || !wears_mech(id))
            continue;
        emit_sound(id, CHAN_STATIC, LOOP_SOUND, LOOP_VOLUME, LOOP_ATTEN, 0, PITCH_NORM);
    }
}
