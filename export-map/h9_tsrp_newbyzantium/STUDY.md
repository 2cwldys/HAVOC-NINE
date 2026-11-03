# New Byzantium -- what the source cities measure

The design brief for `h9_tsrp_newbyzantium`: the three cities H9 already plays, measured with SMAK
(`smak map-character --mod profiles/specialists-roleplay.mjs` and `smak map-wiring`), and what to borrow
from each. The hive merge (`h9_tsrp_hive`) is these three stacked; its BSP2 compile is not a format
`map-character` reads.

Sources: Alexandria `ts_downloads\maps\alexandria_msr_b4v3.bsp` (Steam), Paradise City
`H9XASH\ts\maps\paradisecity_revival_final.bsp`, Xenon City
`The-Specialists-Archive\map-resources\maps\xenoncity_true_b3v2.bsp`.

## The figures

| | Alexandria | Paradise City | Xenon City |
|---|---|---|---|
| extent (x y z) | 7560 x 8012 x 4872 | 7224 x 7779 x 1899 | 4673 x 5467 x 3565 |
| floor (thousand sq units) | 41,219 | 23,344 | 28,198 |
| faces | 28,442 | 16,659 | 16,651 |
| walls off the grid / floor sloped | 13.7% / 7.3% | 11.3% / 5.9% | 12.5% / 7.3% |
| height spread | 650 | 418 | 1163 |
| textures / props / sounds | 444 / 101 / 94 | 236 / 214 / 47 | 68 / 57 / 29 |
| lights / lamp faces | 104 / 1403 | 53 / 1204 | 59 / 583 |
| floor light (avg of 255; share under 24) | 58.9; 21% | 62.1; 13% | 104.3; 15% |
| doors (names) | 111 (97) | 99 (91) | 94 (94) |
| switches / walk-in triggers | 53 / 6 | 45 / 2 | 35 / 0 |
| lifts and trains | 8 | 6 | 9 |
| heal / hurt places | 5 / 0 | 0 / 5 | 2 / 8 |
| teleports | 3 | 0 | 4 |
| breakables that come back | 32 | 14 | 3 |

Every one of them is about 7,500 units across: a whole city fills most of the +/-4096 box by itself.

## What each does well -- what to borrow

**Alexandria (the MSR city).** The biggest and the most wired: 53 switches, an MSR core with four spawn
lifts (`spawn.core.1..4`), a lab with machines that run (`fabricator`, `lab_radio_machine`), blast doors
(`ug.blast`), maintenance gates (`maint.core.gate`), cells. The model for the **MSR Nexus**: a fortified
core you enter by its own lifts, gates that close, a lab, cells. Its dressing (444 textures, 94 sounds)
is the bar for the whole map.

**Paradise City (the lived-in city).** The most props (214) and the most homes: `resident x9`, `citizen x6`,
an estate (`estategatep`), a club (`clubdoor`), storage units, a hideout, a sewer lift, a rebel cart. The
model for the **hab blocks and the market streets**: dense flats, shops and clubs, and props on every
surface. Low and spread (height spread 418): a street city.

**Xenon City (the vertical city).** The tallest (height spread 1163) and the most lifts (9, one with four
stops), a city alert said from nine speakers, luxury flats (`lux_apt`), a prison (`cp_prison x6`), an
armoury, a datacom, gang hideouts, gear shops. The model for **the vertical layers and the neon**: towers
climbed by lift, a city-wide alarm, the rich over the poor. Too evenly bright (104 of 255): New Byzantium
keeps its shade.

## What they look like (refs\*.png, drawn by look.mjs)

The figures above say how much; the pictures say what kind, and the first Core skeleton (a grid of plain
towers under a red sky) missed it entirely. Seen from inside, the three cities are:

- **Night.** A near-black navy sky. The colour is all local light: cyan and teal monitor glow, red-lit
  industrial rooms, MSR purple accents, warm orange flats, fluorescent panels. Never one even wash.
- **Person-sized and mostly interior.** Flats with wood-panelled walls and kitchens (Paradise), white
  sci-fi labs and corridors behind hazard-striped bulkhead doors, datacom rooms walled with monitor banks
  (Xenon), offices with blueprints on the walls, a lobby with a fish tank, bars, cells, MSR spawn bays of
  riveted steel and mesh cages with floor grates (Alexandria).
- **Detailed architecture.** Xenon's bevelled metal trims and chunky angled cornices on every roofline;
  Alexandria's riveted panels, mesh-cage fences, grates and wall consoles; raised catwalks and walkways;
  low walls and rooftops that join.
- **Small, varied, packed.** Low and mid buildings of different shapes close together, something lit or
  enterable everywhere the eye lands; no long empty avenues, no plain boxes.

**The sky (the user's choice): a new dystopian night** -- dark, with a sickly pollution glow low on the
horizon, a distant skyline, searchlights; night like the three cities, but its own.

So New Byzantium is built from the inside out: rooms and their light first, the streets as the spaces
left between small, detailed, lit buildings, at night.

## How they are laid out (smak map-plan, seen from above)

The plans settle what the pictures only hint at: **the three cities are interiors**.
- **Streets are corridors.** Long runs 128 to 350 wide, roofed for most of their length, meet at T-junctions
  and small squares; a few run on the diagonal.
- **Rooms hang off both sides of every street,** 200 to 600 across, through doors. Behind the rooms is solid
  ground (the dark of the plans), not open space: the cities fill only about half of their own square.
- **Open courts are few:** two or three in each (Alexandria's green court, Paradise's two squares).
- **One landmark block dominates each:** Xenon's central tower in its ring road, Alexandria's pit and MSR core.
- **Measured** (`smak map-measure`): ways 228 to 303 wide at the median; headroom 167 to 213; three to five
  floors stacked; sight lines 760 to 1280 at the median.

## New Byzantium's plan (plan.mjs, kit.mjs, city.mjs)

**A regal MSR capital in the same mould.** The city is roofed throughout; the sky shows only where the plan
opens a shaft to it.

**The Well.** An open shaft to the night sky, about 3,300 across, the city's one great view of the sky.
- The Nexus stands in it on 22 grand steps: a domed marble-and-gold hall, its spire rising out of the well.
- All round, the well's walls are the backs of the districts, rows of lit windows and the MSR's banners.

**The lower city (street level 0).**
- Four avenue canyons run out from the well's gates, galleried three floors high.
- A ring road and an outer road cross them; a grid of streets and alleys fills the rest, each line set off
  its even place so no two blocks match.
- Rooms are stacked along every frontage: shops under flats, flats along the galleries. Stair-ramp towers
  climb to the galleries.
- **Eight districts:**

  | District | Character |
  | --- | --- |
  | The Stacks | tenements round an open light well six storeys deep |
  | Spire Heights | luxury, a garden open to the sky |
  | The Bazaar | a market hall of stalls |
  | The Infirmary | clinics and offices |
  | Gate Ward | warehouses by the south gate |
  | The Foundry | a casting hall with catwalks |
  | The Works | workshops |
  | The Rookery | slums in a roofless old hall, shacks inside |

**The ward level (704).** The Nexus's own building, reaching every district:
- enclosed bridges cross the well to a ring round it;
- wings run out over the avenues to a second ring over the ring road;
- a precinct in each of the eight districts holds a front office, cells, a stair up to the wings and a
  ladder down to the sewers.

**The upper city (1056).**
- The Mese is a colonnaded marble arcade under gold ceilings, chandeliers and banners, round the well and
  looking into it, with open bridges to the Nexus hall.
- Off its corners stand the Basilica (a domed nave), the Palace Row of luxury flats, the Ministry with its
  court, and the Exchange with its vault.
- Four grand stair halls climb to it from the avenues.

**The undercity (-704).**
- Sewer mains run under the avenues and the ring, lined with dens; manholes climb up to the streets.
- Under the well lies the great cistern: vaults on columns over black water.

**The canals, beyond the south gate.**
- Open to the sky, with quays, bridges and moored barges.
- The insurgents keep the gutted pump house and the shanties on the south quay.
- The sewers' outfall comes out under the water.

**Built** as spaces carved out of rock, tile by tile, the undercity and the city carved apart. A floor between
stacked rooms is one slab worn on both faces, so the whole city stays under the compiler's 32,768 brushes.

## The city's own spirit

New Byzantium is **Alexandria's sister city**: built in the same world and the same hand, never a copy of
any source's layout. It takes the cities' themes and their texture families, and their ways of being lived
in: debris on the floors, vents through the walls, side routes round every main way, slums under and
between the towers. Sci-fi, dystopian, futuristic -- the MSR's city, as Alexandria is.

## The bar New Byzantium is held to

- **Size**: past the box, as the user chose; the central Core alone about one of these cities.
- **Doors**: 90 to 110 in the Core, every flat and shop enterable (named or not: the RP plugin comes later).
- **Lifts and trains**: 8 or more, one with several stops; the transit line on top.
- **Switches**: 35 to 55 (lamps, TVs, radios, lifts, a city alarm); lamp switches 32 at most (light styles).
- **Dressing**: 100 to 200 props, 50 to 90 sounds, district sounds and storefront signs.
- **Light**: dark, as Alexandria and Paradise are: an average near 60 of 255, a fifth of the floor in
  shadow, neon and lamps doing the lighting.
- **Ground**: 10 to 15% of walls off the grid, 5 to 8% of the floor sloped: streets of boxes are right
  for these cities, not a fault.
