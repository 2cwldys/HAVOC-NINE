# Competitive TS

## Setup for Game Servers
- Put the **required** player models `seal_yellow.mdl` and `merc_blue.mdl` into `models/player` with their own directories, including on fastdl
- Put the module files `easy_http_amxx.dll` `easy_http_amxx_i386.so` in `ts/addons/amxmodx/modules`
- Put the SSL cert file `amxx_easy_http_cacert.pem` in `ts/addons/amxmodx/data`
- Install the plugin `compts.amxx`
- Add `compts_apikey XXXXXXXXXX` to `server.cfg` with your apikey.

- Change cvars in `server.cfg`:
```
mp_teamlist "BLUE;YELLOW"
mp_teammodels "merc_blue|seal_yellow"
```


## Components Summary

- **Component 1**: Plugin for Game Server
- **Component 2**: Webserver
- **Component 3**: Discord

## Requirements

- [AmxxEasyHttp](https://github.com/Next21Team/AmxxEasyHttp)

## Elo Logic
- Overall, elo grows from playing (not zero sum)
- Decays from 1 month+ of inactivity
- Match outcome should be worth hours of DM activity

### Kills (DM, TDM)
- Headshot: +1
- Kill: +1 + bonus
- Death: -1 - (bonus/2)
- Elo bonus: 1 for each 100 apart

### Team Deathmach
- +100 on win
- -70 on loss/disconnect

### Decay
- over 30 days of inactivity (lastseen) results in a daily -10 elo pentalty
