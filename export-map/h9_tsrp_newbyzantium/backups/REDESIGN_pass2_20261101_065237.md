# New Byzantium, pass 2: the redesign

Everything the user asked for on 2026-11-01 after walking the first build, and how to do it. Pass 1 (fixes)
is in plan.mjs/kit.mjs already: wall ladders and breakable grates in the sewer shafts, fitted signs dealt per
street without repeats, a door on every room, fewer upper rooms, trash in place of crates and kept off doorways,
catwalks cut where streets cross, more fog, floating pedestals fixed, two stairwells from the Well into the
cistern, district soundscapes with no tune twice in earshot, no Half-Life sounds (the HL2 dispatcher removed).

## What the user wants (their words, grouped)
- **A theme per district**: "it needs a theme, for each district and area"; parts of the city "look like we
  applied whatever, anywhere". Keep "the theme of the pillars with the stone and gold, like the upper levels".
- **Real buildings**: "more homes than stores"; "bigger stores spanning like 2 rooms"; "no places for real
  estate or proper polished buildings, everything looks like carbon copy storefronts"; "tiny areas everywhere";
  "WAY too many enterable buildings ... a lot of things are poorly textured"; "areas without doors".
- **The Nexus is the MSR's police headquarters**: "the MSR literally have no place to jail people or ... have
  their police headquarters, that's the entire point of the nexus, but it looks like some monument dome";
  "doesn't lead to any MSR building"; "can't reach lower levels from the nexus"; "everything looks like a hollow
  shell".
- **Getting around**: "clear and distinct ways to reach higher and lower parts of the city"; "sprawling hallways
  that go on forever"; "more passageways to other parts of the city"; "parts of the map more easily accessed";
  "repetitive ... like everything's copy pasted".
- **Roads for cars**: "no roads for cars either and it's all foot traffic".
- **Hidden doors and areas**: "hidden doors and hidden areas in some shops and homes, and including the long
  hallways near the top of the nexus, same texture as the walls ... people discover those areas on their own,
  winding side passages and stuff like paradise city".
- **Roleplay first**: not "big crowded street for the entire map size limits, lots of enterable areas, but
  boring and not roleplay accessible".
- Signs varied, aligned and facing right; ordinary debris, nothing in the way; more fog; better sounds.

## Design
### 1. Districts and their palettes
One palette per district, every face of it chosen from that set (walls, floors, ceilings, trims, doors,
windows, sign family, light colour, sounds). Survey the city wads first (render swatches) and choose sets that
belong together; the Mese/Nexus set is the reference look.
| district | character | palette direction |
|---|---|---|
| The Mese and the Nexus | regal MSR capital | marble, gold trim, stone-and-gold pillars, MJST walls/doors |
| Spire Heights | the rich | pale marble and wood, glass, gold accents; luxury apartments |
| The Stacks | working homes | brick and concrete, metal stairs; apartment blocks |
| The Bazaar | the market | tile, canopies; one big market hall, shops two bays wide |
| The Infirmary | clinic | white tile and steel; a hospital building |
| Gate Ward | transit, storage | rough concrete; warehouses, the south gate |
| The Foundry and The Works | industry | rusted metal, grey concrete; factories with catwalks |
| The Rookery | slums | brick, rotten wood, tin; shanties, hidden passages |
| Undercity, canals | sewers, quays | sewer stone, quay concrete; dens, hideouts |

### 2. Buildings instead of one stacker
Replace `frontage`'s single unit type with building types, each with its own facade and interior:
apartment block (lobby, stairwell, two to four flats a floor, numbered doors), townhouse (two storeys, inner
stair), corner shop, big store (two or three bays, open floor), bar or club (main room, back room), clinic,
office, warehouse, precinct, safehouse. Homes outnumber shops (about 60/40 of what can be entered); fewer
entrances overall, each finished: a door, a fitted sign or number, furniture, light.

### 3. The Nexus as MSR headquarters
Inside the octagonal hall, on its floors (352, 704, 1056): public lobby and front desk, booking, a jail block
(a row of cells with grate doors, a guard post), interrogation, offices, briefing room, armory, lockers. Lifts
or stairs between its floors; a route down from the hall to the street plaza and to the undercity; the ward
tubes into the precincts kept. Hidden doors in the long upper hallways (wall texture, func_door).

### 4. Roads
The avenues and the ring become vehicle roads: lanes (asphalt, markings), raised sidewalks with curbs,
crossings at junctions, wide enough for cars; parking/garages off the ring.

### 5. Getting around
Each district a lit, signed landmark: a stair tower or lift at its hub joining street, galleries, ward and
Mese; the Ascents kept. Short connecting passages between districts; long straight corridors broken by
plazas, bends and landmarks. Stairwells to the undercity in every district, not only at the Well.

### 6. Hidden places
About twenty secret doors (func_door in the wall's own texture) in shops, homes and the Nexus's upper
hallways, opening on hidden rooms and winding side passages between districts and down to the undercity.

### 7. Limits to stay inside
Brushes under 32,767 (pass 1: 26,742), brush models under 2,048 (each door is one), edicts under 4,098, the
PHS budget (engine-h9-phsbudget skips it past 192 MB anyway), lightdata under 48 MB, 240 looping sounds.

### 8. Checks
Plan check, compile (full vis, chop 128), renders of every district before and after, a walk test
(reachOf: every room and hidden place reachable), then the user's walk in H9XASH.
