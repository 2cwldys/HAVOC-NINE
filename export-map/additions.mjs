// What this project ADDS to h9_te_neuropolis, on top of the map as it already stands.
//
// THIS IS NOT city.mjs, AND THE DIFFERENCE MATTERS. city.mjs grows the whole city -- the dome, the
// streets, the undercity, the shanty -- onto a bare 21-brush shell. The map has long since moved
// past that: it is a developed 2635-brush city with props, breakables, buttons and sound, built in
// an editor by hand. Running grow() against it would put a SECOND city on top of the first, and
// nothing would say so until you walked into it.
//
// So everything new goes here instead, as a short list of things appended to whatever the base
// already is. The base is read, never rewritten.
import { box, shapeOf } from "../smak/src/maps/source.mjs";

/*
 * What a reactor is made of. One of the map's own textures, so it belongs to the building it
 * stands in rather than looking like something dropped into it -- and a lit panel, so it is
 * findable in a dark room without a light entity of its own.
 */
const T_REACTOR = "cypermonitorblu";

/**
 * A siege objective, as ts_matchmode's MAP_ENTITIES.txt defines one.
 *
 * targetname is the whole contract: the plugin looks for tsm_obj_1 .. tsm_obj_9 and takes them in
 * that order, one per round at most, and what has fallen stays fallen until the match ends. The
 * name is matched as a WHOLE name, lowercase, one digit -- `tsm_obj_10` is not a tenth objective,
 * it is nothing at all.
 *
 * func_wall is the spec's usual choice and the right one here: the verb is the Breacher HOLDING
 * +USE to plant a satchel, not shooting. A func_button would fire for whoever walked up and
 * pressed it and the plugin would never get a say.
 *
 * `target` is optional and fires the instant the objective falls, with the taker as activator --
 * that is where a map puts its explosion, its sparks, its alarm. Left out, the objective still
 * falls, only without the spectacle.
 *
 * Kept an ORDINARY brush entity on purpose: the plugin rebuilds a destroyed body at every round
 * start from what it recorded at map load, and keyvalues the engine turns into hidden class data
 * at spawn (material, gib type) cannot be replayed.
 */
export const objective = (n, lo, hi, texture, keys = {}) => ({
  classname: "func_wall",
  targetname: `tsm_obj_${n}`,
  ...keys,
  brushes: [box(lo, hi, texture)],
});

/**
 * Everything this project adds, appended to the base map.
 *
 * Returns a NEW map object; `base` is not touched. Each group is listed separately and counted, so
 * a build says what it put in rather than only how much bigger things got.
 */
export function addOns(base, opts = {}) {
  const added = [];        // world brushes
  const entities = [];     // brush and point entities
  const notes = [];

  /*
   * THE SIEGE CHAIN, for the siege copy alone (opts.siege, `node make.mjs compile siege`, which
   * builds h9_siege_neuropolis): h9_te_neuropolis is team elimination and carries no objectives.
   * Three of them, taken in order, by a Breacher of the attacking side holding +USE for
   * tsm_obj_time. Felling the last one wins the round.
   *
   * These positions are a FIRST PLACING, measured off the compiled map rather than guessed: the
   * hallway floor is at z 0 and runs y -2100 to -2400 at this x, the Nexus floor is at z 256, and
   * both slums at the hallway's ends are at z 0. They are meant to be moved -- stand where one
   * should be, run tsm_loc, and the numbers it prints go straight in here.
   *
   * Each is a plain box standing on the floor, tall enough to aim at from across a room and narrow
   * enough not to block the way past it.
   */
  const REACTOR = [96, 64, 128];   // how wide, how deep, how tall

  const reactors = [
    { n: 1, at: [1350, -2140, 0], why: "the south hallway, middle" },
    { n: 2, at: [1050, 2530, 256], why: "inside the Nexus, where MSR can defend it" },
    { n: 3, at: [3550, -2300, 0], why: "the slum at the east end of the hallway" },
  ];

  for (const r of opts.siege ? reactors : []) {
    const lo = [r.at[0] - REACTOR[0] / 2, r.at[1] - REACTOR[1] / 2, r.at[2]];
    const hi = [r.at[0] + REACTOR[0] / 2, r.at[1] + REACTOR[1] / 2, r.at[2] + REACTOR[2]];
    entities.push(objective(r.n, lo, hi, T_REACTOR));
    notes.push(`tsm_obj_${r.n} at ${r.at.join(" ")} -- ${r.why}`);
  }

  void added;
  void shapeOf;

  const map = {
    ...base,
    brushes: [...base.brushes, ...added],
    entities: [...base.entities, ...entities],
  };

  return { map, added: added.length, entities: entities.length, notes };
}
