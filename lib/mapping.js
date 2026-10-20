'use strict';

/**
 * Pure mapping helpers between HomeKit values and the fireplace's Tuya data points.
 * No Homebridge or network dependencies, so everything here is unit tested.
 */

const DP = Object.freeze({
  POWER: '1',
  TEMP_SET_C: '2',
  TEMP_UNIT: '9',
  TEMP_SET_F: '10',
  FLAME_STYLE: '101',
  FLAME_COLOR: '102',
  FLAME_SPEED: '103',
  CRACKLE: '104',
  DOWNLIGHT_COLOR: '105',
  DOWNLIGHT_LEVEL: '106',
  DOWNLIGHT_CYCLE: '108',
  EMBER_COLOR: '109',
  EMBER_LEVEL: '110',
  EMBER_CYCLE: '112',
  HEAT_LEVEL: '113',
});

/**
 * The only data points this plugin will ever write. Everything else (factory reset 121,
 * week programs 114-120, custom raw 122/123, timer 13, unit 9, night mode 107, 111) is refused.
 */
const WRITABLE_DPS = Object.freeze(new Set([
  DP.POWER, DP.TEMP_SET_C, DP.TEMP_SET_F, DP.FLAME_STYLE, DP.FLAME_COLOR, DP.FLAME_SPEED,
  DP.CRACKLE, DP.DOWNLIGHT_COLOR, DP.DOWNLIGHT_LEVEL, DP.DOWNLIGHT_CYCLE,
  DP.EMBER_COLOR, DP.EMBER_LEVEL, DP.EMBER_CYCLE, DP.HEAT_LEVEL,
]));

/**
 * Data points each tile needs. Used to warn when a fireplace model does not report them.
 * The set point can come from DP2 (°C) or DP10 (°F), so only one of them is required.
 */
const TILE_DPS = Object.freeze({
  power: [DP.POWER],
  heat: [DP.HEAT_LEVEL],
  lights: [DP.FLAME_COLOR, DP.EMBER_COLOR, DP.EMBER_LEVEL, DP.DOWNLIGHT_COLOR, DP.DOWNLIGHT_LEVEL],
  effects: [DP.FLAME_SPEED, DP.CRACKLE],
  flameStyles: [DP.FLAME_STYLE],
  colorCycle: [DP.EMBER_CYCLE, DP.DOWNLIGHT_CYCLE],
});

/**
 * Data points the enabled tiles need that the fireplace has not reported.
 * Returns [{ tile, dps: [...] }] for each tile with something missing.
 */
function missingDps(reported, tiles) {
  const have = new Set(Object.keys(reported).map(String));
  const out = [];
  for (const tile of tiles) {
    const missing = (TILE_DPS[tile] || []).filter((dp) => !have.has(dp));
    if (tile === 'heat' && !have.has(DP.TEMP_SET_F) && !have.has(DP.TEMP_SET_C)) {
      missing.push(`${DP.TEMP_SET_F} or ${DP.TEMP_SET_C}`);
    }
    if (missing.length) {
      out.push({ tile, dps: missing });
    }
  }
  return out;
}

/** Data points that change looks/sound only (never power or heat). */
const COSMETIC_DPS = Object.freeze(new Set([
  DP.FLAME_STYLE, DP.FLAME_COLOR, DP.FLAME_SPEED, DP.CRACKLE,
  DP.DOWNLIGHT_COLOR, DP.DOWNLIGHT_LEVEL, DP.DOWNLIGHT_CYCLE,
  DP.EMBER_COLOR, DP.EMBER_LEVEL, DP.EMBER_CYCLE,
]));

// ---------- Colors ----------

/** Flame colors (DP102). White is picked by low saturation. */
const FLAME_COLORS = Object.freeze([
  { value: 'YELLOW', name: 'Yellow', hue: 50, sat: 100 },
  { value: 'ORANGE', name: 'Orange', hue: 28, sat: 100 },
  { value: 'BLUE', name: 'Blue', hue: 225, sat: 100 },
  { value: 'GREEN', name: 'Green', hue: 120, sat: 100 },
  { value: 'PURPLE', name: 'Purple', hue: 275, sat: 100 },
  { value: 'WHITE', name: 'White', hue: 0, sat: 0 },
]);

/** Ember bed (DP109) and downlight (DP105) palette, values "1".."10". */
const LIGHT_PALETTE = Object.freeze([
  { value: '1', name: 'Orange', hue: 30, sat: 100 },
  { value: '2', name: 'Red', hue: 0, sat: 100 },
  { value: '3', name: 'Blue', hue: 232, sat: 100 },
  { value: '4', name: 'Yellow', hue: 55, sat: 100 },
  { value: '5', name: 'Green', hue: 120, sat: 100 },
  { value: '6', name: 'Purple', hue: 275, sat: 100 },
  { value: '7', name: 'Sky blue', hue: 195, sat: 75 },
  { value: '8', name: 'Magenta', hue: 310, sat: 100 },
  { value: '9', name: 'White', hue: 0, sat: 0 },
  { value: '10', name: 'Pink', hue: 340, sat: 45 },
]);

/** Below this saturation a flame color request means white. */
const FLAME_WHITE_SAT = 30;

function hueDistance(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
}

/** Point on the HomeKit color wheel disk (radius = saturation). */
function toDisk(hue, sat) {
  const r = Math.max(0, Math.min(100, sat));
  const rad = (hue * Math.PI) / 180;
  return [r * Math.cos(rad), r * Math.sin(rad)];
}

/** Nearest flame color to a HomeKit hue/saturation. */
function snapFlameColor(hue, sat) {
  if (sat < FLAME_WHITE_SAT) {
    return FLAME_COLORS.find((c) => c.value === 'WHITE');
  }
  let best = null;
  for (const c of FLAME_COLORS) {
    if (c.value === 'WHITE') {
      continue;
    }
    const d = hueDistance(hue, c.hue);
    if (!best || d < best.d) {
      best = { c, d };
    }
  }
  return best.c;
}

/** Nearest of the 10 ember/downlight colors, measured on the color wheel disk. */
function snapPaletteColor(hue, sat) {
  const [x, y] = toDisk(hue, sat);
  let best = null;
  for (const c of LIGHT_PALETTE) {
    const [cx, cy] = toDisk(c.hue, c.sat);
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (!best || d < best.d) {
      best = { c, d };
    }
  }
  return best.c;
}

function flameColorByValue(value) {
  return FLAME_COLORS.find((c) => c.value === value) || null;
}

function paletteColorByValue(value) {
  return LIGHT_PALETTE.find((c) => c.value === String(value)) || null;
}

// ---------- Stepped enums <-> RotationSpeed (0..3) ----------

/** Heat: speed 1..3 = Fan only / Low heat / High heat. */
const HEAT_LEVELS = Object.freeze(['FAN', 'LOW_HEAT', 'HIGH_HEAT']);
const FLAME_SPEEDS = Object.freeze(['SLOW', 'DEFAULT', 'FAST']);
/** Crackle: speed 1..3 = Low / Medium / High (OFF is speed 0 / inactive). */
const CRACKLE_LEVELS = Object.freeze(['DEFAULT', 'MEDIUM', 'HIGH']);

/** Clamp/round a HomeKit RotationSpeed (0..3) to a step 0..3. */
function toStep(speed) {
  const n = Math.round(Number(speed));
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(3, n));
}

/** RotationSpeed -> enum value, or null for 0 (off). */
function speedToEnum(levels, speed) {
  const step = toStep(speed);
  return step === 0 ? null : levels[step - 1];
}

/** Enum value -> RotationSpeed 1..3, 0 for unknown/OFF. */
function enumToSpeed(levels, value) {
  const i = levels.indexOf(value);
  return i < 0 ? 0 : i + 1;
}

// ---------- Temperature ----------

const TEMP_F_MIN = 68;
const TEMP_F_MAX = 90;
const TEMP_C_MIN = 20;
const TEMP_C_MAX = 31;

function fToC(f) {
  return Math.round(((f - 32) * 5 / 9) * 100) / 100;
}

function cToF(c) {
  return (c * 9) / 5 + 32;
}

/** HomeKit °C -> device °F: nearest even number in 68..90. */
function celsiusToDeviceF(c) {
  const f = cToF(c);
  const even = Math.round(f / 2) * 2;
  return Math.max(TEMP_F_MIN, Math.min(TEMP_F_MAX, even));
}

/** HomeKit °C -> device °C (DP2 when the unit is set to Celsius): whole degrees in 20..31. */
function celsiusToDeviceC(c) {
  return Math.max(TEMP_C_MIN, Math.min(TEMP_C_MAX, Math.round(c)));
}

// ---------- Brightness ----------

function clampPercent(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, n));
}

// ---------- Safety ----------

/**
 * Decide what to do with a write requested from a light/effect control.
 * Returns 'send', 'queue' (hold until the fireplace is on) or 'refuse'.
 *
 * - Anything that turns a light or effect ON while the fireplace is off is refused,
 *   so those controls can never power the fireplace on.
 * - Cosmetic-only changes while off (a color, a speed) are queued, or sent if the
 *   live test showed the fireplace ignores them while off (cosmeticWhileOff = 'send').
 */
function gateCosmeticWrite({ powerOn, turnsSomethingOn, cosmeticWhileOff = 'queue' }) {
  if (powerOn) {
    return 'send';
  }
  if (turnsSomethingOn) {
    return 'refuse';
  }
  return cosmeticWhileOff === 'send' ? 'send' : 'queue';
}

/** Throws if a write payload contains any data point outside the allow-list. */
function assertWritable(dps) {
  const keys = Object.keys(dps);
  if (keys.length === 0) {
    throw new Error('Empty write');
  }
  for (const k of keys) {
    if (!WRITABLE_DPS.has(String(k))) {
      throw new Error(`Refusing to write data point ${k}`);
    }
  }
}

module.exports = {
  DP,
  WRITABLE_DPS,
  TILE_DPS,
  COSMETIC_DPS,
  FLAME_COLORS,
  LIGHT_PALETTE,
  FLAME_WHITE_SAT,
  HEAT_LEVELS,
  FLAME_SPEEDS,
  CRACKLE_LEVELS,
  TEMP_F_MIN,
  TEMP_F_MAX,
  TEMP_C_MIN,
  TEMP_C_MAX,
  hueDistance,
  snapFlameColor,
  snapPaletteColor,
  flameColorByValue,
  paletteColorByValue,
  toStep,
  speedToEnum,
  enumToSpeed,
  fToC,
  cToF,
  celsiusToDeviceF,
  celsiusToDeviceC,
  clampPercent,
  gateCosmeticWrite,
  assertWritable,
  missingDps,
};
