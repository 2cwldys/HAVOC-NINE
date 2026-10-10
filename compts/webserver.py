import sqlite3
import time
import sys
import os
import shutil
from functools import wraps

import yaml
import requests
import flask
from flask import request, Response


def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d


def steamid64_to_steam(steamid64):
    """
    Converts a 64-bit SteamID to the STEAM:x:y:z format.

    :param steamid64: 64-bit SteamID as an integer or string
    :return: SteamID in STEAM:x:y:z format
    """
    steamid64 = int(steamid64)
    universe = (steamid64 >> 56) & 0xFF
    y = steamid64 % 2
    z = (steamid64 - 76561197960265728) // 2
    return f"STEAM:{universe}:{y}:{z}"


def steam_to_steamid64(steam):
    """
    Converts a STEAM:x:y:z format SteamID to a 64-bit SteamID.

    :param steam: SteamID in STEAM_:x:y:z format
    :return: 64-bit SteamID as an integer
    """
    steam = steam.replace("_", ":")
    parts = steam.split(":")
    if len(parts) != 4 or not parts[1].isdigit() or not parts[2].isdigit() or not parts[3].isdigit():
        raise ValueError("Invalid STEAM_x:y:z format")
    
    universe = int(parts[1])
    y = int(parts[2])
    z = int(parts[3])
    return str((z * 2) + 76561197960265728 + y)


if not os.path.exists('data/players.db'):
    shutil.copy('data/players.empty.db', 'data/players.db')
if not os.path.exists('config.yaml'):
    shutil.copy('config.example.yaml', 'config.yaml')


config = yaml.load(open('config.yaml', 'r'), Loader=yaml.SafeLoader)

def apikey_required(func):
    @wraps(func)
    def decorated_view(*args, **kwargs):
        if request.headers.get('apikey') not in config.get('apikeys'):
            return flask.abort(401)
        return func(*args, **kwargs)
    return decorated_view


app = flask.Flask(__name__)


@app.context_processor
def inject_invite_link():
    return dict(discord_invite=config.get('discord_invite'))


def get_players():
    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players ORDER BY elo DESC LIMIT 100')
        players = cursor.fetchall()
    
    return players


@app.route('/players.json')
def players_json():
    players = [{'a': x['avatar'], 's': x['steamid'],  'u': x['url'], 'n': x['name'], 'e': x['elo']} for x in get_players()]
    response = flask.jsonify(players)
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response


@app.route('/')
def index():
    return flask.render_template('home.html', players=get_players())


@app.route('/report/kill', methods=['POST'])
@apikey_required
def report():
    killer = request.headers.get('killer')
    victim = request.headers.get('victim')
    headshot = int(request.headers.get('headshot'))

    killer64 = steam_to_steamid64(killer)
    victim64 = steam_to_steamid64(victim)

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (killer64,))
        killerdata = cursor.fetchone()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (victim64,))
        victimdata = cursor.fetchone()

    if not killerdata:
        killerdata = update_player_data(killer64)
    if not victimdata:
        victimdata = update_player_data(victim64)

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (killer64,))
        killerdata = cursor.fetchone()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (victim64,))
        victimdata = cursor.fetchone()

        elo_diff = victimdata['elo'] - killerdata['elo']
        bonus = min(elo_diff / 100, 0)

        victimdata['elo'] -= 1 + bonus / 2
        killerdata['elo'] += 1 - bonus + headshot

        victimdata['elo'] = int(victimdata['elo'])
        killerdata['elo'] = int(killerdata['elo'])

        cursor.execute('UPDATE players SET elo = ? WHERE steamid = ?', (victimdata['elo'], victim64))
        cursor.execute('UPDATE players SET elo = ? WHERE steamid = ?', (killerdata['elo'], killer64))

        conn.commit()

    return Response(content_type='text/plain', response='')


@app.route('/match/<int:match_id>')
def matchview(match_id):
    return flask.render_template('match.html', match_id=match_id)


@app.route('/player/<string:steamid>/update')
def playerview_update(steamid):
    return playerview(steamid, update=True)


@app.route('/player/<string:steamid>')
def playerview(steamid, update=False):
    try:
        if 'STEAM_' in steamid:
            steamid = steam_to_steamid64(steamid)
    except Exception as e:
        print(e)
        return flask.abort(400, 'Invalid SteamID')

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (steamid,))
        player = cursor.fetchone()

    player = get_player_data(steamid, update=update)

    return flask.render_template('player.html', player=player)


@app.route('/check_elo')
@apikey_required
def check_elo():
    
    steamid = request.headers.get('steamid')

    steamid64 = steam_to_steamid64(steamid)

    player = get_player_data(steamid64)
    update_lastseen(steamid64)

    elo = player['elo']

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        # get the rank of the player, which is the number of players with higher elo + 1
        cursor.execute('SELECT COUNT(*) AS rank FROM players WHERE elo > ?', (elo,))
        rank = cursor.fetchone()

    rank = rank['rank'] + 1

    return Response(content_type='text/plain', response=f'{steamid} {elo} {rank}')


def update_lastseen(steamid):
    now = int(time.time())

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('UPDATE players SET lastseen = ? WHERE steamid = ?', (now, steamid))
        conn.commit()


@app.route('/cron')
def cron():
    # if flask is not in debug, or remote_addr is not 127.0.0.1 return 403
    if not any([app.debug, request.remote_addr != '127.0.0.1', request.host == 'localhost']):
        return flask.abort(403)

    now = int(time.time())

    # if last cron run was less than 24 hours ago, return
    try:
        with open('data/last_cron.txt', 'r') as f:
            last_cron = int(f.read())
        if now - last_cron < 24 * 60 * 60 - 1:
            return Response(content_type='text/plain', response='', status=204)
    except:
        pass

    # update last cron timestamp
    with open('data/last_cron.txt', 'w+') as f:
        f.write(str(now))

    once_a_day()

    return Response(content_type='text/plain', response='')


def once_a_day():
    print('Running once a day tasks')
    now = int(time.time())

    # update top 100 players from steam
    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT steamid FROM players ORDER BY elo DESC LIMIT 100')
        players = cursor.fetchall()

    players = ','.join([str(player['steamid']) for player in players])
    api_key = config.get('steam_webapi_key')
    url = f"https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={api_key}&steamids={players}"
    response = requests.get(url).json()
    player_infos = response['response']['players']

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        for player_info in player_infos:
            steamid = player_info['steamid']
            name = player_info['personaname']
            avatar = player_info['avatarfull']
            url = player_info['profileurl']

            cursor.execute("UPDATE players SET name = ?, avatar = ?, url = ? WHERE steamid = ?", (name, avatar, url, steamid))

        conn.commit()

    #  ELO DECAY
    # for each player, if lastseen was > 30 days ago, -5 from their elo
    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players')
        players = cursor.fetchall()
        for player in players:
            if now - player['lastseen'] > 30 * 24 * 60 * 60:
                cursor.execute('UPDATE players SET elo = ? WHERE steamid = ?', (player['elo'] - 5, player['steamid']))
        conn.commit()


def get_player_data(steamid, update=False):
    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM players WHERE steamid = ?', (steamid,))
        player = cursor.fetchone()

    if not player or update:
        player = update_player_data(steamid)

    return player


def update_player_data(steamid):
    now = int(time.time())
    api_key = config.get('steam_webapi_key')
    url = f"https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={api_key}&steamids={steamid}"
    response = requests.get(url)
    data = response.json()
    print(data)
    player_info = data['response']['players'][0]

    name = player_info['personaname']
    avatar = player_info['avatarfull']
    url = player_info['profileurl']

    with sqlite3.connect('data/players.db') as conn:
        conn.row_factory = dict_factory
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM players WHERE steamid = ?", (steamid,))
        player = cursor.fetchone()

        if player:
            cursor.execute("UPDATE players SET name = ?, avatar = ?, url = ?, lastseen = ? WHERE steamid = ?",
                           (name, avatar, url, player['lastseen'], steamid))
        else:
            cursor.execute("INSERT INTO players (steamid, name, avatar, url, lastseen, elo) VALUES (?, ?, ?, ?, ?, ?)",
                           (steamid, name, avatar, url, now, 1000))

        conn.commit()

        cursor.execute("SELECT * FROM players WHERE steamid = ?", (steamid,))
        player = dict(cursor.fetchone())

    return player


if __name__ == "__main__":
    with app.test_request_context():
        cron()

    if 'debug' in sys.argv or os.name == 'nt':
        app.debug = True
        app.jinja_env.auto_reload = True
        app.config['TEMPLATES_AUTO_RELOAD'] = True
        app.run(host='0.0.0.0', port=config.get('PORT', 8030))
    else:
        import bjoern
        bjoern.run(app, '0.0.0.0', config.get('PORT', 8030))
