1. Create an 'addons' folder in your mod folder.

2. Add precache.amxx to your <mod>/addons/amxmodx/plugins folder.

3. Ensure AMXX is installed.

4. Edit liblist.gam (open with notepad):

Check to see if the lines :
gamedll "addons\metamod\dlls\metamod.dll"

Is there, if not, add it
and change:
gamedll "dlls/server.dll"
to:
//gamedll "dlls/server.dll"

Save, then make read only in properties.

5. Place contents of EntMod4 into your mod folder.

6. Add yourself as an admin for Entmod and AMXX.
(Read docs/CUSTOM_XASH_USERID.md for those using the H9XASH client.)


Go to <mod>\addons\EntMod
Open DF_admins.txt

(H9XASH users will need additional compatibility in DF_admins.txt)

Inside the text file, admins are added in this format:
STEAM ID;PASSWORD;1
To find your steam id:
https://steamid.io

Go to <mod>\addons\amxmodx\configs
Open users.ini

Start a new line
Add:
"STEAMID/XASHID HERE" "" "abcdefghijklmnopqrstu" "ce";


7. In the same folder that user.ini is located, open plugins.ini
and at a new line, add "precache.amxx"






## Ingame setup

Load the_betterthanbest_entmap2

You'll notice everything is yellow.
Verify your setup of entmod by checking the console for amx, or entmod msgs.

Enter in the console:
setinfo _entpass [password]
[password] : the password you put in the DF_admins.txt
(there is a space between 'setinfo' and '_entpass')

Now type in console:
e_kill env_fog 9999

If you get an unknown command, wait 10-20 seconds.
If unknown command msg persists, Entmod may not have been setup correctly.

If this command worked, close your game and go back to your Sven Co-op folder.
Go to <mod>\addons\amxmodx\configs\precache
Open up default.pre (using notepad)
add this:
precache_sound common/null.wav

Entmod is now completely setup.




## Basic Commands
Enter these into console in game.

# The Essentials
• weapon_entmover - Pull out the ent mover
primary fire: grab an entity
secondary fire: delete an entity
• +copyent - copy an entity you are looking at (best to bind this to a key)
• entmod_noclip 1/0 - disable/enable noclip

# Movement
e_rotate_x - rotate entity 15 degrees around x axis
e_rotate_y - rotate entity 15 degrees around y axis
e_rotate_z - rotate entity 15 degrees around z axis
mm_grab - select an entity for multiple grab
mm_start - begin moving all selected entites
mm_end - stop all entities from moving
t_select [name] - select entity for train
t_start - move around for train's path
t_end - stop train editiing mode
t_go - start moving train

e_god 1/0 - make player/entity/monster have godmode
e_kill [classname] [maximum distance]
(e.g. e_kill env_fog 9999)




## Advanced Commands

# Useful commands
entmod_lookingat - shows info about what you are looking at (model, coordinates, spawnflags)
entmod_create rpg_rocket 1 - fire a rocket
e_stack [number] [x] [y] [z] - copy a number of entities with x y z displacements

entmod_keyvalue [flag] [value] - change value of an entity
useful keyvalue list: https://sites.google.com/site/svenmanor/entguide/

e_add [classname]:flag:keyvalue:flag:keyvalue......

(e.g.: e_add weapon_shotgun:origin:%HERE%:iuser1:models/houndeye.mdl:)

e_classname [classname] - change an entity's classname


# Glowing
e_render [on/off] [transparency] [mode] [red] [green] [blue]
Transparency, red, green, blue range b/w 0-255
(e.g. e_render 1 255 1 150 0 25)

# Portals
e_telestart [name1] - create an entry teleporter
e_teleend [name1] - create an exit teleporter
You can create multiple teleports, make sure each pair has a unique name.

e_teledelete [name1] - deletes pair of teleporters with name [name1]

# Saving/Loading Entities
es_start [name] - begin a save with the name [name]
es_grab - grab an entity you want to save
es_graball [classname] - grab all entities of type [classname]
(e.g. es_graball monster_scientist)
es_save 1/0 - saves
(es_save 1 - everything spawns near you, have to disable with mm_end)
(es_save 0 - everything spawns where it was first saved, does not need mm_end)

es_list - shows a list of saved entites
es_load [name] - load [name]