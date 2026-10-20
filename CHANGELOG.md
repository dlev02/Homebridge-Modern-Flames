# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [1.1.0] - 2026-10-19

First public release.

### Added
- Data point check: on first connect, the plugin warns once if the fireplace doesn't report a data point that a
  shown tile needs (helps with Modern Flames models other than the Orion Slim/Multi).
- `model` setting for the model string shown in the Home app.
- Settings validation: a missing device ID, IP or key, or a key that isn't 16 characters, is logged clearly
  and the plugin stays idle instead of crashing the bridge.
- README: setup, how to get the device ID and local key from the Tuya developer portal, the data point map,
  limitations and troubleshooting.
- ESLint (`npm run lint`), GitHub Actions CI on Node 20/22/24, MIT license file, bug report template,
  CONTRIBUTING.md and a one-step release script (`release.ps1`).

### Changed
- Tile names follow the **Name** setting ("<Name>", "<Name> Heat", "<Name> Lights"). With the default name
  "Fireplace" nothing changes.
- The default model string is now "Electric Fireplace" (was "Orion Slim/Multi (E004-131)"). Set `model` to keep
  the old text.
- The migration script from homebridge-tuya / homebridge-tuya-plus no longer has a built-in config path
  (default `~/.homebridge/config.json`), takes `--id` to pick the device, refuses entries with other devices,
  and writes a timestamped backup first.
- Tests load HAP-NodeJS from the `homebridge` dev dependency instead of a global install.

## [1.0.0] - 2026-10-18

Initial private version.

- Fireplace (power), Fireplace Heat (heater + Fan Only / Low Heat / High Heat), Fireplace Lights (Flames,
  Ember Bed, Downlight) and Flame Effects (flame speed, crackle and flame style radio switches).
- Lights and effects can never power the fireplace on; color/effect changes made while off are queued.
- Write allow-list: factory reset, weekly programs, timer and raw data points can't be written.
- Persistent LAN connection with reconnect backoff, No Response while unreachable, write coalescing.

[1.1.0]: https://github.com/dlev02/homebridge-modern-flames/releases/tag/v1.1.0
[1.0.0]: https://github.com/dlev02/homebridge-modern-flames/releases/tag/v1.0.0
