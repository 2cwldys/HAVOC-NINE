/*
 * ApolloRP_H9Ctx.inc -- H9: an entry in the context menu of the use key on a player.
 *
 * With arp_h9_ctxmenu 1 the use key on a living player opens a menu of what the player can do to him (ARP_H9Ctx, docs\ARP_INVENTORY.txt, 10): the exchange of
 * goods, the search, the cuffs, a fine, money, a license shown, and the entries of other plugins. A plugin adds an entry through the one native below and the one
 * forward, and the entry follows the rule of every other: it is listed, and when it does not apply now it is greyed with the reason.
 *
 *   forward ARP_H9CtxBuild(id, target)       ARP_H9Ctx calls it in every plugin that has it, each time it builds the menu of `id` on `target`: when the menu
 *                                            opens and every half second while it is up. The menu is not kept: what the plugin adds now is the menu now.
 *   native ARP_H9CtxAdd(label, handler, ...) adds an entry; valid only inside ARP_H9CtxBuild. The handler is a public function of the calling plugin,
 *                                            public handler(id, target). It runs when the player chooses the entry, after the menu has been built again and the
 *                                            entry found in it and enabled: a choice of an entry that is gone, or has been greyed meanwhile, never reaches it.
 *                                            While it runs the player's aim is on `target` (get_user_aiming finds him from the player's eye), so a handler that
 *                                            acts on the player looked at works as it does for the player's own command; the aim is given back when it returns.
 *
 * An entry whose plugin goes away (paused, unloaded) is not asked for any more, so it is gone from the next menu and from the one that is up within half a
 * second; a choice of it in between is refused with a note. The menu lists the first four entries that plugins add, after its own.
 *
 * A plugin that wants the entry only when ARP_H9Ctx is there takes the native filter (the native is then not called, and the plugin loads without it):
 *
 *   public plugin_natives()
 *       set_native_filter("ARP_H9CtxFilter")
 */

#if defined _ApolloRP_H9Ctx_included
	#endinput
#endif

#define _ApolloRP_H9Ctx_included

#include <amxmodx>

/// The label is at most 23 characters of ASCII; the note at most 33: with an enabled entry it is a small detail drawn dim after the label ("uses Cuffs"),
/// with a greyed one the reason ("Police only"). Returns 1 when the entry was added, 0 when not (outside ARP_H9CtxBuild, the menu is full, or no label).
native ARP_H9CtxAdd(const label[], const handler[], bool:enabled = true, const note[] = "");

/// For plugin_natives(): lets a plugin load, and call ARP_H9CtxAdd harmlessly, on a server that does not run ARP_H9Ctx.
public ARP_H9CtxFilter(const name[], index, trap)
{
	return equal(name, "ARP_H9CtxAdd") ? PLUGIN_HANDLED : PLUGIN_CONTINUE;
}
