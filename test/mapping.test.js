'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/mapping');

test('flame hue snaps to the nearest of the 6 flame colors', () => {
  assert.equal(M.snapFlameColor(0, 100).value, 'ORANGE'); // red is closest to orange
  assert.equal(M.snapFlameColor(30, 100).value, 'ORANGE');
  assert.equal(M.snapFlameColor(55, 100).value, 'YELLOW');
  assert.equal(M.snapFlameColor(130, 90).value, 'GREEN');
  assert.equal(M.snapFlameColor(200, 100).value, 'BLUE');
  assert.equal(M.snapFlameColor(240, 100).value, 'BLUE');
  assert.equal(M.snapFlameColor(280, 100).value, 'PURPLE');
  assert.equal(M.snapFlameColor(330, 100).value, 'PURPLE');
  assert.equal(M.snapFlameColor(355, 100).value, 'ORANGE');
});

test('low saturation flame request means white', () => {
  assert.equal(M.snapFlameColor(200, 0).value, 'WHITE');
  assert.equal(M.snapFlameColor(30, 20).value, 'WHITE');
  assert.equal(M.snapFlameColor(30, 40).value, 'ORANGE');
});

test('every flame color snaps to itself', () => {
  for (const c of M.FLAME_COLORS) {
    assert.equal(M.snapFlameColor(c.hue, c.sat).value, c.value);
  }
});

test('ember/downlight palette: every color snaps to itself', () => {
  for (const c of M.LIGHT_PALETTE) {
    assert.equal(M.snapPaletteColor(c.hue, c.sat).value, c.value, c.name);
  }
});

test('ember/downlight palette: nearby colors', () => {
  assert.equal(M.snapPaletteColor(5, 100).name, 'Red');
  assert.equal(M.snapPaletteColor(350, 100).name, 'Red');
  assert.equal(M.snapPaletteColor(345, 50).name, 'Pink');
  assert.equal(M.snapPaletteColor(0, 5).name, 'White');
  assert.equal(M.snapPaletteColor(190, 70).name, 'Sky blue');
  assert.equal(M.snapPaletteColor(240, 100).name, 'Blue');
  assert.equal(M.snapPaletteColor(305, 95).name, 'Magenta');
  assert.equal(M.snapPaletteColor(60, 100).name, 'Yellow');
});

test('heat speed <-> level', () => {
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 0), null);
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 1), 'FAN');
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 2), 'LOW_HEAT');
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 3), 'HIGH_HEAT');
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 2.4), 'LOW_HEAT');
  assert.equal(M.speedToEnum(M.HEAT_LEVELS, 99), 'HIGH_HEAT');
  assert.equal(M.enumToSpeed(M.HEAT_LEVELS, 'FAN'), 1);
  assert.equal(M.enumToSpeed(M.HEAT_LEVELS, 'HIGH_HEAT'), 3);
  assert.equal(M.enumToSpeed(M.HEAT_LEVELS, 'OFF'), 0);
});

test('flame speed and crackle speed <-> enum', () => {
  assert.deepEqual([1, 2, 3].map((s) => M.speedToEnum(M.FLAME_SPEEDS, s)), ['SLOW', 'DEFAULT', 'FAST']);
  assert.deepEqual([0, 1, 2, 3].map((s) => M.speedToEnum(M.CRACKLE_LEVELS, s)), [null, 'DEFAULT', 'MEDIUM', 'HIGH']);
  assert.equal(M.enumToSpeed(M.CRACKLE_LEVELS, 'OFF'), 0);
  assert.equal(M.enumToSpeed(M.CRACKLE_LEVELS, 'MEDIUM'), 2);
});

test('°F <-> °C', () => {
  assert.equal(M.fToC(68), 20);
  assert.equal(M.fToC(90), 32.22);
  assert.equal(M.celsiusToDeviceF(20), 68);
  assert.equal(M.celsiusToDeviceF(21.1), 70);
  assert.equal(M.celsiusToDeviceF(21.7), 72); // 71.06 °F -> nearest even is 72
  assert.equal(M.celsiusToDeviceF(22.2), 72);
  assert.equal(M.celsiusToDeviceF(32.2), 90);
  assert.equal(M.celsiusToDeviceF(10), 68); // clamped
  assert.equal(M.celsiusToDeviceF(40), 90); // clamped
  for (let f = 68; f <= 90; f += 2) {
    // Round trip through HomeKit's 0.1 °C precision lands on the same even °F.
    const c = Math.round(M.fToC(f) * 10) / 10;
    assert.equal(M.celsiusToDeviceF(c), f, `${f} °F`);
  }
  assert.equal(M.celsiusToDeviceC(19), 20);
  assert.equal(M.celsiusToDeviceC(25.4), 25);
  assert.equal(M.celsiusToDeviceC(32.2), 31);
});

test('refuse-on-while-off gate', () => {
  // Fireplace on: everything is sent.
  assert.equal(M.gateCosmeticWrite({ powerOn: true, turnsSomethingOn: true }), 'send');
  assert.equal(M.gateCosmeticWrite({ powerOn: true, turnsSomethingOn: false }), 'send');
  // Fireplace off: turning a light/effect on is always refused, whatever the setting.
  assert.equal(M.gateCosmeticWrite({ powerOn: false, turnsSomethingOn: true }), 'refuse');
  assert.equal(M.gateCosmeticWrite({ powerOn: false, turnsSomethingOn: true, cosmeticWhileOff: 'send' }), 'refuse');
  // Fireplace off: pure cosmetic changes are queued by default.
  assert.equal(M.gateCosmeticWrite({ powerOn: false, turnsSomethingOn: false }), 'queue');
  assert.equal(M.gateCosmeticWrite({ powerOn: false, turnsSomethingOn: false, cosmeticWhileOff: 'send' }), 'send');
});

test('write allow-list never lets reset, programs or raw data points through', () => {
  for (const dp of ['121', '114', '117', '120', '122', '123', '13', '9', '107', '111']) {
    assert.throws(() => M.assertWritable({ [dp]: true }), /Refusing/);
  }
  assert.throws(() => M.assertWritable({ 1: true, 121: true }), /Refusing/);
  assert.throws(() => M.assertWritable({}), /Empty/);
  assert.doesNotThrow(() => M.assertWritable({ 1: true, 113: 'LOW_HEAT', 10: 70 }));
});

test('missing data point check', () => {
  const all = { 1: true, 10: 72, 101: 'ONE', 102: 'YELLOW', 103: 'DEFAULT', 104: 'OFF', 105: '1', 106: 0,
    108: false, 109: '1', 110: 60, 112: false, 113: 'OFF' };
  const tiles = Object.keys(M.TILE_DPS);
  assert.deepEqual(M.missingDps(all, tiles), []);
  // Celsius-only models report DP2 instead of DP10.
  const celsius = { ...all, 2: 22 };
  delete celsius[10];
  assert.deepEqual(M.missingDps(celsius, ['heat']), []);
  assert.deepEqual(M.missingDps({ 1: true }, ['power', 'heat']), [{ tile: 'heat', dps: ['113', '10 or 2'] }]);
  // Only the tiles asked about are checked.
  assert.deepEqual(M.missingDps({ 1: true }, ['power']), []);
});
