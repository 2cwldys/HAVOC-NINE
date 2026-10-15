These .dll edits are done with reTS, which is considered decompiled and recompiled The Specialists source code.
Allowing the ability to no longer fight with conflicting userinfo or causing client userinfo overflow crashes with custom playermodel enforcement.

mp_teammodels_force:
1 (default) - you can only use your own team's models. If you pick one with model x it sticks, and changing your name or anything else in your userinfo no longer rerolls it like TS 3.0 does
2 - any model except the other teams' models. This is the one for your custom model plugins
0 - any model at all, enemy team models included. Your plugin handles everything

For our purposes, we use 0 with plugin enforcement.