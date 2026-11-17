
Stripper2 - Version 1.0 (February 2nd, 2002)

Stripper2 is a metamod (www.metamod.org) plugin that will allow you to remove
(strip out) or add (create) entities in a BSP map file for Half-Life or MODs
for Half-Life.  You will need metamod installed and configured on your server
if you want to use the Stripper plugin.

Stripper2 does not actually modify the BSP map file.  When entities are being
removed from the map, Stripper2 simply prevents them from being spawned after
the map file is loaded.  When entities are being created, Stripper2 will add
these new entities after the map file is loaded.  In either case, there are
no modifications required to the BSP map files (*.bsp), so clients will not
have to download anything when they connect to the server.

To set up Stripper2 you should first make sure you have metamod installed and
configured properly for your server.  If you have installed AdminMOD, you will
already have metamod installed and configured.  If you have not installed
metamod, you can download it from the metamod web site at...

http://www.metamod.org/


Metamod installation for Windows servers:

Copy the metamod.dll file to the MODs dlls folder (the default for Team
Fortress 1.5 is C:\SIERRA\Half-Life\tfc\dlls, the default for Counter-Strike
is C:\SIERRA\Half-Life\cstrike\dlls, and the default for Half-Life deathmatch
is C:\SIERRA\Half-Life\valve\dlls).  Then, using any text editor (like Notepad),
modify the liblist.gam file in the MODs folder and change the "gamedll" entry
so that it uses the "metamod.dll" file instead of the game DLL file.  For
example, to change the Half-Life deathmatch liblist.gam file in the "valve"
folder, you would have this...

//gamedll "dlls\hl.dll"
gamedll "dlls\metamod.dll"

...I have commented out the original gamedll line and added a new gamedll line
that specifies "dlls\metamod.dll" as the file to load.  You should now be able
to start the server and you should see something like this...

   Metamod version 1.11.00, Copyright (c) 2001 Will Day <willday@metamod.org>
   Metamod comes with ABSOLUTELY NO WARRANTY; for details type `meta gpl'.
   This is free software, and you are welcome to redistribute it
   under certain conditions; type `meta gpl' for details.


Metamod installation for Linux servers:

Copy the metamod_i386.so file to the MODs dlls directory (for example
/usr/hlds_l/tfc/dlls for Team Fortress 1.5, /usr/hlds_l/cstrike/dlls for
Counter-Strike, or /usr/hlds_l/valve/dlls for Half-Life deathmatch).  Then
modify the liblist.gam file in the MODs directory and change the
"gamedll_linux" entry so that it uses the "metamod_i386.so" file instead
of the game DLL file.  For example, to change the Half-Life deathmatch
liblist.gam file in the "valve" directory, you would have this...

//gamedll_linux "dlls/hl_i386.so"
gamedll_linux "dlls/metamod_i386.so"

...I have commented out the original gamedll line and added a new gamedll line
that specifies "dlls/metamod_i386.so" as the file to load.  You should now be
able to start the server and you should see something like this...

   Metamod version 1.11.00, Copyright (c) 2001 Will Day <willday@metamod.org>
   Metamod comes with ABSOLUTELY NO WARRANTY; for details type `meta gpl'.
   This is free software, and you are welcome to redistribute it
   under certain conditions; type `meta gpl' for details.


Configuring Metamod to work with plugins:

First, copy the stripper2_mm.dll file into the same dlls folder where you put
the metamod.dll file (for Linux, copy the stripper2_mm_i386.so to the same
directory where you copied the metamod_i386.so file).

Then, you will need to create a file called "metamod.ini" in the MODs folder
(the same place where the liblist.gam file is found).  You can create this
file with any text editor.  You will want it to contain these two lines...

win32 dlls/stripper2_mm.dll
linux dlls/stripper2_mm_i386.so

...IMPORTANT!!!  Note that both win32 and linux use FORWARD SLASHES '/' when
specifying the plugin filename.  Don't use the backslash '\' for Windows.

Now when you start the server, you should see the Metamod banner message
and right after it, you should see the STRIPPER2 banner message, like this...

[STRIPPER2] Stripper2 v1.00.00, 02/02/2002
[STRIPPER2] by botman <botman@planethalflife.com>


How to find the entities available in a MOD:

You can get a list of all of the entities in a MOD by looking on the metamod
website at this webpage...

http://www.metamod.org/gamesupport.html

Click on the "[ents]" column for the MOD you want and it will display a list
of all of the entities available in that MOD.  Many MODs also use many of the
entities from the Half-Life deathmatch DLL, so you might want to look at the
[ents] section for Half-Life deathmatch even if that is not the MOD that you
are running on your server.

I've also included a small Windows application that will generate a text file
with the list of entities supported by a MOD DLL file.  Run the "entities.exe"
application and browse to the folder with the Half-Life MOD DLL that you wish
to use (for example C:\SIERRA\Half-Life\cstrike\mp.dll).  When the DLL file is
selected, the entities application will create a text file in the same folder
as the MOD DLL file (with the extension of .txt).  You can view this file
using any text editor.

If you want to dump the list of entities on a Linux system, you can 'cd' to
the dlls directory of the MOD and use the following command on the .so file...

nm -g hl_i386.so | grep ' T [a-z]' | grep -v '__' | awk '{print $3}'

...this can be redirected to a text file by adding "> file.txt" at the end
(without the double quotes).

Some mapping tutorial websites are also helpful in determining which entities
are available in MODs.  For example this website...

http://www.karljones.com/halflife/almanac.asp

...has a section on entities...

http://www.karljones.com/halflife/entities.asp

...that gives the names of weapon, item and ammo entities.

Another resource for determining the names of entities is to use my BSP tools
package...

http://planethalflife.com/botman/bsp_tool.shtml

...and use the "bsp_tool" application to dump the entities contained within
a BSP map file.  Here's an example of dumping the entities in boot_camp...

C:\BSP_tool> bsp_tool -ent boot_camp.bsp > boot_camp.txt

...this will create a text file called boot_camp.txt.  All of the entity names
will appear on the "Key/Value" lines with "classname" as the Key.

You might also want to look through the .fgd file (if there is one available)
for that MOD.  The .fgd file is used by people who create maps for the MOD.
You can usually find this .fgd file on the website that distributes the MOD.
You can view the contents of the .fgd file by opening the file in any text
editor (like Notepad).


Configuring Stripper2:

Now you will want to create configuration files for Stripper2 to use when
loading a map.  There's 2 different types of configuration files.  When a
map loads, Stripper2 will look for a configuration file that is specifically
made for that map.  The filename for these map specific configuration files
will be in the following format mapname_str.cfg (where "mapname" is the name
of the BSP map file).  These map specific configuration files MUST be in the
maps folder found inside the MOD folder.  For example, if you wanted to create
a map specific configuration file for the map 2fort in Team Fortress 1.5, the
file would be "C:\SIERRA\Half-Life\tfc\maps\2fort_str.cfg".

If a map specific Stripper2 configuration file does not exist, Stripper2 will
use the generic configuration file "stripper2.cfg" found in the MOD folder
(where the liblist.gam file is found).  For example, for Counter-Strike, this
file would be "C:\SIERRA\Half-Life\cstrike\stripper2.cfg".

The only items you can put in the generic "stripper2.cfg" configuration file
is the name of entities that you want to remove from the game.  These entity
names are the same names that are used when the map is created.  For example,
if you wanted to remove all of the shotguns from a Half-Life deathmatch game
you would add the following line to the stripper2.cfg file...

weapon_shotgun


Each entity name should be on a separate line in the stripper2.cfg file.
Here's an example that removes the RPG, shotgun, healthkits, hand grenades,
and tripmines from Half-Life deathmatch...

weapon_rpg
weapon_shotgun
item_healthkit
weapon_handgrenade
weapon_tripmine


You can also set up items in the generic configuration file so that they
are randomly stripped out of the map.  To do this, simply put a percentage
after the name of the entity.  For example...

weapon_crossbow 80%

...will randomly remove the crossbow 80 percent of the time.  If you specify
a random percent, that item will be removed, on the average, the percent of
time you specify.  This means that if you set a percent to 40%, then 40% of
the time an item will be removed from the map.  This DOES NOT mean that 40%
of the time when you load this map, there won't be any of those items.  This
means that if there are normally 10 items spawning in a map, you would only
get about 6 of them each time the map is loaded.  There currently is no way
to configure an item so that all of them appear sometimes and none of them
appear other times.


Configuring the map specific Stripper2 configuration files:

The map specific Stripper2 configuration files allow you to remove (strip
out) or add (create) entities when the BSP map is loaded.  There are two
sections in the map specific Stripper2 configuration files.  The first is
indicated by "[strip]" (without the quotes).  The "[strip]" token must be
on a line by itself.  Everything below the "[strip]" token will be items
that are to be stripped out of the map.  The second section is indicated
by "[add]" (without the quotes).  The "[add]" token must be on a line by
itself.  The "[add]" section is where you place items that you want to add
to the map.

In the "[strip]" section, you can specify the entity name, the entity
location in that map, and a random percent of time to remove that entity.
For example you might have this in the "[strip]" section...

[strip]
weapon_crossbow
item_healthkit 100%
weapon_rpg 50%
ammo_shotgun (-140 920 -1450)
weapon_handgrenade (40 -720 1554) 80

...This will cause all of the crossbows to be removed (no specified percent
is the same as 100% of the time).  All of the healthkits will be removed.
The RPG weapon(s) will be removed 50% of the time.  The shotgun ammo located
at (-140 920 -1450) will be removed.  And the hand grenade located at (40
-720 1554) will be removed 80 percent of the time (note that the '%' sign is
optional and not required).

In the "[add]" section, you will need to specify a group of "key/value" pairs.
A key/value pair is the way that Worldcraft stores information about entities.
There is a "key" part that identifies what key (or field) is being set.  And
there is a "value" part that identifies what value that key should be set to.
For example, in the following key/value pair...

target/secret_door

...the key is "target" and the value is "secret_door".  For a key/value pair,
the key is the text before the '/' character and the value is anything after
the '/' character.

When you add an entity, you specify it's classname (the entity name), the
origin of the entity in map 3D coordinates, and any other specific information
that is needed to create the new entity (for example, the angle that the
entity is facing (0-360 degrees), the sprite or model used by that entity,
a target name for entities that trigger other entities, etc.).  Every new
entity that you create MUST have a "classname" key and an "origin" key.  I
have created some example map specific Stripper2 configuration files that
are included in the Stripper2 .zip file for you to look at.  You can view
these with any text editor.

The group of key/value pairs that create an entity starts with a '{' character
(on a line by itself) and ends with a '}' character (on a line by itself).
For example, this is a complete group of key/value pairs to create a new
player spawn point in Counter-Strike...

{
   classname/info_player_start  // Counter-Terrorist spawn point
   angle/180
   origin/640 240 48
}

...Notice that it contains a "classname" key with the name of the entity that
will be created (info_player_start).  It also contains an "angle" key (to
indicate what direction the player should face when spawning) and it contains
an "origin" key which is the 3D map coordinate where this spawn point will be
located.  Notice that I also have a comment (indicated by the 2 forward slash
characters "//").  You can place comments anywhere you want to in the map
specific configuration files, just remember that anything AFTER the double
slashes will be ignored.

If you place a percentage after the group of key/value pairs, like this...

{
   classname/info_player_start  // Counter-Terrorist spawn point
   angle/180
   origin/640 240 48
} 70%

...it means that the entity will be created a random percent of the time.
In this example, the entity will be created only 70 percent of the time.
This allows you to randomly add entities to a map.  Sometimes when the map
loads, the entity will be at that location and sometimes it will not.

You can also group several entity groups together to randomly select
one of those entities from the group.  For example, if I wanted to spawn
a hostage in a Counter-Strike map, but I wanted it to appear at random
locations (not at the same location each time the map loads), I could do
something like this...

// Add a hostage at one of 3 random locations...
{
   {
      classname/hostage_entity
      angle/0
      model/models/hostage.mdl
      skin/0
      origin/-495 2284 335
   }
   {
      classname/hostage_entity
      angle/0
      model/models/hostage.mdl
      skin/1
      origin/-616 2856 335
   }
   {
      classname/hostage_entity
      angle/0
      model/models/hostage.mdl
      skin/0
      origin/-520 1720 255
   }
}

...Here I've specified 3 entity groups, each with the key/value pairs needed
to define that entity.  When the map loads, the Stripper2 plugin will select
one of these 3 at random and create that entity (the other 2 will be ignored).
You do not have to specify the same type of entity (classname) in each of
these entity groups.  For example, if you wanted to randomly spawn one of
three types of weapons at a location in a deathmatch map, you could do
something like this...

{
   {
      classname/weapon_rpg
      angle/45
      delay/0
      origin/-265 470 -1790
   } 20%
   {
      classname/weapon_snark
      angle/180
      delay/0
      origin/-265 470 -1790
   } 10%
   {
      classname/weapon_shotgun
      angle/90
      delay/0
      origin/-265 470 -1790
   }
}

...Notice that each of these has the same origin (the same location in the
map), so when the Stripper2 plugin will randomly select one of them and
spawn it at that location in the map.  Notice that in this example, I've
added a random percent after each entity group.  The RPG weapon will
be selected about 20 percent of the time, the snark weapon will be selected
about 10 percent of the time, and the shotgun will be selected about 70
percent of the time (100 percent minus the total of the other specified
percentages).  If you have multiple entity groups and don't specify a
percentage for more than one of them, like this...

{
   {
      classname/info_player_deathmatch
      angle/0
      origin/500 1300 -1780
   } 20%
   {
      classname/info_player_deathmatch
      angle/90
      origin/480 1270 -1780
   } 10%
   {
      classname/info_player_deathmatch
      angle/180
      origin/480 1240 -1780
   }
   {
      classname/info_player_deathmatch
      angle/270
      origin/520 1230 -1780
   }
}

...the groups without a percentage specified will be given an equal
percentage of the remainder of 100 percent minus the total percent
that was specified.  In this case since I specified 20% and 10%,
for a total of 30%, the remainder is 70% (100%-30%=70%).  The 70%
will be equally divided among the groups that didn't have a percentage
specified (i.e. the last two will each be 35%).

As with the single groups, the multiple groups can have a random
percentage of how often they will be created.  For example...

{
   {
      classname/weapon_snark
      angle/180
      delay/0
      origin/-265 470 -1790
   }
   {
      classname/weapon_shotgun
      angle/90
      delay/0
      origin/-265 470 -1790
   }
} 80%

...would create either a snark or a shotgun, 80 percent of the time.  80
percent of the time there would be one of those two weapons spawned and
20 percent of the time there wouldn't be anything spawned.

You can only nest the multiple entity groups 2 levels (as I have shown
above).  You can't create something like this...

{
   {
      {
         classname/weapon_snark
         origin/250 190 -1540
      }
      {
         classname/weapon_tripmine
         origin/250 190 -1540
      }
   } 20%
   {
      {
         classname/info_player_deathmatch
         origin/250 190 -1540
      }
      {
         classname/info_player_deathmatch
         origin/220 -120 1290
      }
   } 80%
}

...in an attempt to spawn either a snark or tripmine 20 percent of the time
and spawn a player spawn point at one of two locations the other 80 percent
of the time.  Again, this type of configuration is NOT allowed.  You can only
do something similar to the examples that are 2 levels deep.


Configuring Stripper2 to log items added or removed:

You can configure the Stripper2 plugin so that it will log the entities that
were removed (stripped) or created (added) in a map.  To do this you will
need to create a file called "metaexec.cfg" in the MODs folder (where the
liblist.gam file and the metamod.ini file is located).  In this metaexec.cfg
file you will need to add the following line...

stripper2_log 1

...save this file.  Then you will need to enable logging when you start up
your server.  This can be done by adding "+log on" on the command line when
starting your server, or you can add "log on" (without the quotes) in your
server.cfg file.  The log files will be placed in a "logs" folder in the MOD
folder (for example C:\SIERRA\Half-Life\cstrike\logs).

If you want to turn off the Stripper2 plugin logging, you can change the
"stripper2_log" setting from "1" to "0" in the metaexec.cfg file.  To turn
off logging completely, remove the "+log on" from the command line, or remove
the "log on" entry from the server.cfg file.


Some general tips on adding entities:

You might wonder, "How do I know what origin to use when adding an entity to
a map file?".  The easiest way to determine an origin in a map file is to
load that map in Half-Life, then pull down the console (using the '~' key)
and enter "status" and press ENTER.  This will display a line similar to the
following...

hostname:   TheKillingGrounds
version :   45/1.1.0.8 1786
tcp/ip  :   245.20.53.173:27015
map     :   boot_camp at:  -1540 x, 895 y, 145 z
players :   1 active (8 max)

...the "map" line contains the current map name and the 3D map location
where your player origin is currently at.  The player origin is ALWAYS at
the center of the body.  For Half-Life deathmatch, the player is 72 units
tall, 32 units wide and 32 units deep.  This means that if you are standing
right up against a wall, your origin is still 16 units away from the wall.

When you want to know the 3D coordinates of some point in the map, you can
run around until you get near that location, then use the console to enter
the "status" command (without the quotes), to print out what your current
location is.

Another method to determine the origin in maps is to use my BSP tools and
run the BSP viewer (bsp_view) to display a map...

http://planethalflife.com/botman/bsp_tool.shtml

The BSP viewer will constantly display the X, Y, and Z coordinates of your
location as you fly around in the map.  Also with the BSP viewer, you can
display the player spawn points (using player models) to determine where
existing spawn points are in maps.  This will help you if you plan on adding
new spawn points to a map.

When adding new entities to a map, make SURE that these new entities aren't
touching anything else in the map INCLUDING ANY WALLS OR FLOORS.  When you
spawn an entity in a map, it's best to make its origin several units up
in the air off the floor.  It will drop down to the floor when it spawns.
If you create one entity touching another entity, they will get "stuck"
together and won't work properly (you won't be able to pick up weapons,
or, in the case of player spawn points, neither player will be able to
move).  So make SURE you leave plenty of room between entities when you
create them.

One of the problem that I ran into when creating entities is that some
entities need to have a bounding box around them so that you can "touch"
them properly.  This bounding box is what Half-Life uses for collision
detection to know when you have touched something.  Some entities (like
weapons) will create the bounding box themselves when they spawn).  Other
entities (like triggers) will need for you to specify what the size of the
bounding box is.  The way you do this with the Stripper2 plugin is by using
the "bbox_min" and "bbox_max" key/values.  The bbox_min value should be a 3D
coordinate relative to the origin of the entity.  The bbox_max value should
also be a 3D coordinate relative to the origin of the entity.  For example,
if I wanted to spawn a teleport trigger, I could do something like this...

{
   classname/trigger_teleport
   target/teleport_one
   origin/-480 940 -1660
   bbox_min/-20 -20 -30
   bbox_max/20 20 30
}

...This would create a teleport trigger located at (-480 940 -1660) in the
map, and would create a bounding box that was 40 units wide, 40 units deep
and 60 units high (a little bit wider than the player and not quite as tall
as the player).  Since I used an equal negative offset for the bbox_min as
I did a positive offset for the bbox_max, the origin will be in the center
of this bounding box.  However, I could also have done something like this...

{
   classname/trigger_teleport
   target/teleport_one
   origin/-480 940 -1660
   bbox_min/-20 -20 0
   bbox_max/20 20 60
}

...Note that this time there is no negative offset in the Z axis for the
bbox_min and a larger positive offset in the Z axis for the bbox_max.  This
will have the effect of creating a bounding box at the same height as the
origin of the teleport trigger and the bounding box will be completely
above this new entity.

Another problem that I ran into while creating entities is that you need
to PRECACHE models, sprites and sounds for entities BEFORE you create them.
If you don't precache these, the server will exit with an error message
telling you that you didn't precache something.  To allow you to precache
a model, sprite, or sound, I have created a special command in the map
specific configuration file.  These commands are:

PRECACHE_MODEL(models/modelname.mdl)
PRECACHE_SPRITE(sprites/spritename.spr)
PRECACHE_SOUND(ambience/soundname.wav)

...where "modelname.mdl", "spritename.spr", or "soundname.wav" would be
replaced by the model filename, sprite filename or sound filename,
respectively.  Note that models, sprites and sounds MAY be found in the
pak0.pak file instead of in the MOD directory.  Some MODs will create
directories for models, sprites and sounds, and some will place these
files in the pak0.pak file.  You may need to download a pak viewer (like
PakExplorer) to view the contents of .pak files.

Models should always be found in the "models" folder of a MOD.  Sprites
should always be found in the "sprites" folder of a MOD.  Note that
the "models" or "sprites" folder name is part of the name you specify
when precaching that item.  HOWEVER, note that the "sound" folder IS NOT
part of the name you specify when precaching the item.  Half-Life will
ALWAYS look in the sound folder for .wav file sounds and you SHOULD NOT
include the "sound" part of the path in the filename.

For examples of using the PRECACHE commands for spawning entities, see
the map specific configuration files included with the Stripper2 plugin.

One other thing that I should note here.  If you create custom models,
sprites, or sounds, these items will downloaded to the client's machine
when they connect to your server.  I have created a custom sprite, called
"botman.spr" for the crossfire map specific configuration file.  You will
need to place this botman.spr file in the valve\sprites folder, if you
want to try out my example configuration file for crossfire.  The first
time that a client connects to the server, the botman.spr file will be
downloaded to that client.  Each time they connect after that, they will
not need to download this file (as long as it doesn't get deleted from
the client's machine).

This allows you to create models, sprites, or sounds so that you can
customize your server.  HOWEVER, be aware that some users turn off custom
downloads to their machine.  These users will NOT be able to see any of
the custom models or sprites, or hear the custom sounds that you have
created.  Don't create any entities using custom models, sprites or sounds
that would cause these clients any problems playing the game (i.e. walking
into something that they can not see because they did not download it).
