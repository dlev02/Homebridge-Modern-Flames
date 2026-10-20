# homebridge-modern-flames

[![npm](https://img.shields.io/npm/v/homebridge-modern-flames)](https://www.npmjs.com/package/homebridge-modern-flames)
[![CI](https://github.com/dlev02/homebridge-modern-flames/actions/workflows/ci.yml/badge.svg)](https://github.com/dlev02/homebridge-modern-flames/actions/workflows/ci.yml)

Local (LAN) Homebridge plugin for **Tuya-based Modern Flames electric fireplaces**. It talks to the fireplace
over your home network with [`tuyapi`](https://github.com/codetheweb/tuyapi). After setup it needs no cloud
and no account.

I built this because I wanted a better Modern Flames experience in Apple Home than a generic Tuya plugin
gives: plain-language tiles, every feature the fireplace has, and guard rails so a light or a scene can never
switch the heater on by accident.

Apple Home has no fireplace accessory, so the plugin splits the fireplace's controls across up to four
clearly labeled tiles: a power switch, a heater, color lights and a set of effect switches.
See [Why it works this way](#why-it-works-this-way) for the trade-offs.

**What it covers**

- Power on/off, separate from everything else.
- Heat: fan only, low or high heat, and the target temperature (°F or °C, whichever the fireplace is set to).
- Flame color (6 colors), plus ember bed and downlight color and brightness (10 colors each).
- Flame speed, crackle sound volume and the three flame styles, as named switches that Siri understands.
- Optional ember bed and downlight color-cycle switches.
- Live status: changes from the remote or the phone app show up in Home right away, and an unreachable
  fireplace shows No Response instead of stale values.
- Several fireplaces: add one entry per fireplace.

**Tested on:** Modern Flames Orion Slim / Orion Multi (Tuya protocol 3.3). Other Modern Flames models with a
Wi-Fi module that works in the Smart Life app probably use the same data points. On first start the plugin
checks and warns if yours doesn't. See [Data points](#data-points) and please
[open an issue](https://github.com/dlev02/homebridge-modern-flames/issues) with your model if it works,
or if it doesn't.

> Not affiliated with or endorsed by Modern Flames or Tuya. Use at your own risk; this controls a heater.

## What shows up in the Home app

| Tile | Controls | Notes |
|---|---|---|
| **Fireplace** | On/off switch | Power only. It is separate on purpose, so "Hey Siri, turn on the fireplace" never also starts the heat. |
| **Fireplace Heat** | Heater (on/off, target temperature, 3-step speed) plus **Fan Only / Low Heat / High Heat** switches | The switches are the easy way to pick a level; turn the lit one off to stop heating. On the heater's speed slider, 1 = fan only, 2 = low, 3 = high. **Turning heat on also turns the fireplace on.** Turning heat off leaves the flame running. |
| **Fireplace Lights** | **Flames** (color), **Ember Bed** (color + brightness), **Downlight** (color + brightness) | Flames: 6 colors (yellow, orange, blue, green, purple, white; pick a pale color for white). Ember Bed and Downlight: 10 colors. The color picker snaps to the nearest color the fireplace has. Turning **Flames** off turns the fireplace off. |
| **Flame Effects** | **Slow / Normal / Fast Flames**, **Crackle Low / Medium / High**, **Flame Style 1 / 2 / 3** | Each group works like radio buttons: turning one on turns the others in its group off. Turn the lit Crackle switch off for silence. Rename the styles in Home (for example "Tall Flames"); the plugin keeps your names. |

The tile names follow the **Name** setting: with the name "Den Fireplace" you get "Den Fireplace",
"Den Fireplace Heat" and "Den Fireplace Lights".

### Safety rules built in

- **Only "Fireplace" and "Fireplace Heat" can turn the fireplace on.** While it is off, turning on any light,
  effect or style is ignored and the tile flips back.
- Color and effect changes made while the fireplace is off are saved and applied when it next turns on
  (*Advanced → queue*, the default). Switch to *send* only if you have tested that your fireplace ignores them
  while off.
- The plugin can only write the data points it needs. Factory reset (DP121), the weekly programs (DP114–120),
  the timer, the temperature unit and the raw custom data points are blocked in code.
- If the fireplace can't be reached, the tiles show **No Response** rather than stale values. The connection
  stays open with a heartbeat and reconnects with backoff. Changes made with the remote or the app show up in
  HomeKit right away.
- The local key is never written to the log.

### Why it works this way

Apple decides which kinds of accessories the Home app can show, and a fireplace isn't one of them. The plugin
has to build the fireplace out of the pieces Apple offers: switches, a heater and color lights. I picked the
combination that made the most sense day to day. Some of it can still feel a little odd, and that comes from
the Home app, not from a bug:

- **Heat is a "heater" tile.** Home always shows a current temperature on it, and the fireplace has no room
  sensor, so the tile shows the target temperature there. Its speed slider shows 33/67/100% instead of fan/low/high,
  which is why the Fan Only / Low Heat / High Heat switches are there too.
- **Flames is a light.** That's the only way to get a color picker. Since the flames *are* the fireplace,
  turning Flames off turns the fireplace off. Turning it on does nothing while the fireplace is off (safety rule).
- **Effects are switches.** Home has no "mode picker" or "sound" control. Named radio-style switches are the
  clearest way to show "Fast Flames" or "Crackle Medium" in Home and to Siri.
- **The color picker is free-form, the fireplace isn't.** You can pick any color, and the plugin snaps it to the
  closest one the fireplace has.

If you find a layout that works better, please open an issue. I'm happy to change it.

## Setup

1. Install **Modern Flames Fireplace** from the Plugins tab of the Homebridge UI, or run
   `npm install -g homebridge-modern-flames`.
2. Give the fireplace a fixed IP address (a DHCP reservation) in your router.
3. Find its **device ID** and **local key** (below).
4. Open the plugin settings and fill in the name, device ID, IP address and local key. Leave the protocol at 3.3
   unless you know your fireplace uses another version.
5. Restart Homebridge. Running the plugin as a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges)
   is recommended.

Equivalent `config.json` entry (one per fireplace):

```json
{
  "platform": "ModernFlames",
  "name": "Fireplace",
  "deviceId": "<Tuya device ID>",
  "ip": "192.168.1.50",
  "key": "<16-character local key>",
  "protocolVersion": "3.3",
  "model": "Orion Slim 60",
  "hideHeat": false,
  "hideLights": false,
  "hideEffects": false,
  "hideFlameStyles": false,
  "showColorCycle": false,
  "cosmeticWhileOff": "queue"
}
```

| Setting | Default | Meaning |
|---|---|---|
| `name` | `Fireplace` | Base name for the tiles. |
| `deviceId`, `ip`, `key` | (required) | See below. |
| `protocolVersion` | `3.3` | Tuya LAN protocol: `3.3`, `3.4` or `3.5`. |
| `model` | `Electric Fireplace` | Model string shown in the Home app's accessory details. |
| `hideHeat` / `hideLights` / `hideEffects` | `false` | Hide a whole tile. |
| `hideFlameStyles` | `false` | Hide the Flame Style 1/2/3 switches. |
| `showColorCycle` | `false` | Add Ember Bed and Downlight color-cycle switches to the Lights tile. |
| `cosmeticWhileOff` | `queue` | `queue`: hold color/effect changes made while off until the fireplace turns on. `send`: send them right away. |

### Finding the device ID and local key

Tuya devices encrypt their LAN traffic with a per-device **local key**. You get it once from Tuya's free
developer portal. The fireplace keeps working in the app as before.

1. Add the fireplace to the **Smart Life** (or **Tuya Smart**) app and check that you can control it there.
   If you set it up in a different, brand-specific app, that account may not link to the developer portal;
   add the fireplace to Smart Life instead.
2. Sign up at [platform.tuya.com](https://platform.tuya.com) (formerly iot.tuya.com).
3. **Cloud → Development → Create Cloud Project.** Pick *Smart Home* for industry and development method, and
   the **data center that matches your app account's region** (for example *Western America* for US accounts).
   Accept the default API services; *IoT Core* must be included.
4. In the project, open **Devices → Link App Account → Add App Account**. In the Smart Life app, go to
   **Me → scan icon (top right)** and scan the QR code. Your devices appear in the list with their
   **Device ID**.
5. Open **Cloud → API Explorer → Device Management → Query Device Details**, enter the device ID and submit.
   The response contains `"local_key"`. That is the 16-character **Local key**. The same response shows the
   device's public IP. Ignore that, because you need its LAN address from your router.

The portal renames its menus from time to time; if a name above doesn't match, look for the closest one.
Command-line alternatives that use the same project credentials (Access ID and Secret from the project's
Overview page): `npx @tuyapi/cli wizard`, or the Python tool `python -m tinytuya wizard`. `tinytuya scan` also
lists Tuya devices on your network with their IP and protocol version.

Keep the key private. **If you remove the fireplace from the app and add it again, the device ID and local
key change**, and you'll need to look them up again. If the IoT Core trial on the developer portal expires,
the plugin keeps working, because it only needs the portal to look the key up.

### Moving from homebridge-tuya / homebridge-tuya-plus

The **Fireplace** tile uses the same accessory ID that homebridge-tuya and homebridge-tuya-plus use for the
device. If the new entry runs on the **same bridge** (the same `_bridge` block, or both on the main bridge),
the existing tile keeps its room, name and automations. Remove the fireplace from the `TuyaLan` platform at the
same time, because two accessories with the same ID on one bridge won't start.

If the fireplace is the only device in its `TuyaLan` entry, a helper script can do the switch for you. Stop
Homebridge first. It writes a timestamped backup next to `config.json`:

```bash
node "$(npm root -g)/homebridge-modern-flames/scripts/migrate-from-tuya-plus.js" ~/.homebridge/config.json
```

Then uninstall the old plugin if nothing else uses it, and start Homebridge.

## Things to know (limitations)

- Target temperature is 68–90 °F in 2 °F steps (or 20–31 °C when the fireplace is set to Celsius). Requests in
  between are snapped.
- The Heat tile's on/off reflects the heat setting (fan/low/high), not the flame.
- Ember Bed and Downlight "off" sets their brightness to 0. Turning them back on restores the last brightness.
- Rapid changes (dragging a slider) are merged so only the latest value is sent. If the fireplace applies a
  command without replying, the plugin re-reads its status before reporting a failure.
- Timer, night mode, weekly programs and the °C/°F unit are not exposed (use the remote or the app).
- Only one LAN connection at a time is reliable on many Tuya devices. Don't control the same fireplace from two
  local integrations at once (for example this plugin and Home Assistant's Local Tuya). The phone app over the
  cloud is fine.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Tiles show **No Response**, and the log says *not reachable* | The IP address (did it change? reserve it), that Homebridge and the fireplace are on the same network/VLAN, and that no other local integration is connected to it. |
| Connects, then drops right away, or no status ever arrives | Wrong local key (re-paired?) or wrong protocol version. Look the key up again; try 3.4 if 3.3 never works. |
| *Local key must be 16 characters* | A copy/paste problem; the key is exactly 16 characters. |
| *has not reported some data points the plugin expects* | Your model uses a different data point map. Hide the tiles it names, and open an issue with the debug log. |
| A light or effect switch flips back off | The fireplace is off. Turn on **Fireplace** first (by design). |
| Homebridge reports a duplicate UUID on start | The fireplace is still configured in homebridge-tuya / tuya-plus on the same bridge. Remove it there. |

For details, turn on **Debug** for the bridge that runs this plugin. The log then lists every data point the
fireplace reports (`Data points reported:` and `State changed:`) and every write the plugin sends.

## Data points

The plugin expects this Tuya data point (DP) map, as reported by the Orion Slim/Multi. You can see your
fireplace's DPs in the debug log, or on the developer portal in the API Explorer (for example
*Device Control → Query Things Data Model*).

| DP | Meaning | Values | Used by |
|---|---|---|---|
| 1 | Power | `true` / `false` | Fireplace, Flames off, Heat on |
| 2 | Target temperature °C | 20–31 | Heat (when DP9 is `c`) |
| 9 | Temperature unit | `c` / `f` | read only |
| 10 | Target temperature °F | 68–90, step 2 | Heat (when DP9 is `f`) |
| 101 | Flame style | `ONE` / `TWO` / `THREE` | Flame Style 1/2/3 |
| 102 | Flame color | `YELLOW` `ORANGE` `BLUE` `GREEN` `PURPLE` `WHITE` | Flames |
| 103 | Flame speed | `SLOW` / `DEFAULT` / `FAST` | Slow/Normal/Fast Flames |
| 104 | Crackle volume | `OFF` / `DEFAULT` / `MEDIUM` / `HIGH` | Crackle Low/Medium/High |
| 105 | Downlight color | `"1"`–`"10"` | Downlight |
| 106 | Downlight brightness | 0–100 | Downlight |
| 108 | Downlight color cycle | `true` / `false` | optional switch |
| 109 | Ember bed color | `"1"`–`"10"` | Ember Bed |
| 110 | Ember bed brightness | 0–100 | Ember Bed |
| 112 | Ember bed color cycle | `true` / `false` | optional switch |
| 113 | Heat | `OFF` / `FAN` / `LOW_HEAT` / `HIGH_HEAT` | Heat |
| 13, 107, 111, 114–123 | Timer, night mode, accessory, weekly programs, factory reset, custom | | **never written** |

Ember bed and downlight colors `"1"`–`"10"`: orange, red, blue, yellow, green, purple, sky blue, magenta,
white, pink.

## Development

```bash
npm install
npm run lint
npm test
```

The tests cover the color snapping, speed and temperature mappings, the refuse-while-off rules, the write
allow-list and the data point check. They also drive the real HomeKit services through HAP-NodeJS (from the
`homebridge` dev dependency) with the network stubbed out, so they never talk to a fireplace.

To try a local checkout in Homebridge: `npm install -g /path/to/homebridge-modern-flames` (this links the folder),
then restart the bridge that runs it.

## Contributing

Bug reports, new models and improvements are very welcome. Please
[open an issue](https://github.com/dlev02/homebridge-modern-flames/issues) or a pull request here. This is a
niche plugin, and owners are best served by one well-maintained version instead of several forks that drift
apart. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Made by Drew ([@dlev02](https://github.com/dlev02)). More of my projects are at
[drewlevinson.me](https://drewlevinson.me).

## License

[MIT](LICENSE). Free for anyone to use, change and share.
