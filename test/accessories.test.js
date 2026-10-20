'use strict';

/**
 * Drives the real accessory handlers through HAP-NodeJS with the TCP layer stubbed out,
 * to check the safety rules end to end (nothing here talks to the network).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const fs = require('node:fs');

// Homebridge comes from devDependencies; HOMEBRIDGE_ROOT can point at another install.
const HB_ROOT = process.env.HOMEBRIDGE_ROOT || path.join(__dirname, '..', 'node_modules', 'homebridge');
const HB_FOUND = fs.existsSync(path.join(HB_ROOT, 'package.json'));

let hap;
let PlatformAccessory;
try {
  hap = HB_FOUND ? require(require.resolve('@homebridge/hap-nodejs', { paths: [HB_ROOT] })) : null;
} catch {
  hap = null;
}

const { ModernFlamesPlatform } = require('../lib/platform');
const { FireplaceDevice } = require('../lib/device');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLog() {
  const lines = [];
  const log = (...a) => lines.push(['info', a.join(' ')]);
  log.info = (...a) => lines.push(['info', a.join(' ')]);
  log.warn = (...a) => lines.push(['warn', a.join(' ')]);
  log.error = (...a) => lines.push(['error', a.join(' ')]);
  log.debug = () => undefined;
  log.lines = lines;
  return log;
}

const KEY_PLACEHOLDER = 'k'.repeat(16);
const DEVICE_ID = 'bf1234567890abcdefgh12'; // made up

async function setup(initial, config = {}) {
  if (!PlatformAccessory) {
    ({ PlatformAccessory } = await import(pathToFileURL(path.join(HB_ROOT, 'dist', 'platformAccessory.js')).href));
  }
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  api.registered = [];
  api.registerPlatformAccessories = (p, n, accs) => api.registered.push(...accs);
  api.unregisterPlatformAccessories = () => undefined;
  api.updatePlatformAccessories = () => undefined;

  const log = makeLog();
  const platform = new ModernFlamesPlatform(log, {
    platform: 'ModernFlames', deviceId: DEVICE_ID, ip: '127.0.0.1', key: KEY_PLACEHOLDER, ...config,
  }, api);

  // Stub the TCP layer before setup() starts it.
  const writes = [];
  const origStart = FireplaceDevice.prototype.start;
  FireplaceDevice.prototype.start = function start() {
    this.tuya.set = async ({ data }) => {
      writes.push({ ...data });
      // Device echoes back what was written, except it ignores writes it can't take.
      const echo = {};
      for (const [k, v] of Object.entries(data)) {
        echo[k] = v;
      }
      setTimeout(() => this._onData({ dps: echo }), 5);
      return true;
    };
    this.tuya.get = async () => ({ dps: { ...this.state } });
    this._connected = true;
    this._onData({ dps: initial });
  };
  api.emit('didFinishLaunching');
  FireplaceDevice.prototype.start = origStart;

  const byName = {};
  for (const acc of api.registered) {
    byName[acc.displayName] = acc;
  }
  return { api, platform, device: platform.device, writes, log, acc: byName };
}

function svc(acc, subtype) {
  return acc.services.find((s) => s.subtype === subtype);
}

async function set(service, Char, value) {
  const c = service.getCharacteristic(Char);
  await c.handleSetRequest(value);
}

async function get(service, Char) {
  return service.getCharacteristic(Char).handleGetRequest();
}

const OFF_STATE = {
  1: false, 9: 'f', 10: 72, 101: 'ONE', 102: 'YELLOW', 103: 'DEFAULT', 104: 'OFF',
  105: '1', 106: 0, 109: '1', 110: 60, 113: 'OFF', 108: false, 112: false,
};

const skip = hap ? false : 'Homebridge not found (run npm install, or set HOMEBRIDGE_ROOT)';

test('layout: 4 accessories, Fireplace reuses the homebridge-tuya UUID and "switch 1" service', { skip }, async (t) => {
  const { acc, device } = await setup(OFF_STATE);
  t.after(() => device.stop());
  assert.deepEqual(Object.keys(acc).sort(), ['Fireplace', 'Fireplace Heat', 'Fireplace Lights', 'Flame Effects']);
  assert.equal(acc.Fireplace.UUID, hap.uuid.generate(`homebridge-tuya:${DEVICE_ID}`));
  const nonInfo = acc.Fireplace.services.filter((s) => s.UUID !== hap.Service.AccessoryInformation.UUID);
  assert.equal(nonInfo.length, 1);
  assert.equal(nonInfo[0].subtype, 'switch 1');
  assert.equal(nonInfo[0].getCharacteristic(hap.Characteristic.ConfiguredName).value, 'Fireplace');
  const lights = acc['Fireplace Lights'].services.map((s) => s.getCharacteristic(hap.Characteristic.Name).value);
  assert.ok(lights.includes('Flames') && lights.includes('Ember Bed') && lights.includes('Downlight'));
  const effects = acc['Flame Effects'].services.map((s) => s.getCharacteristic(hap.Characteristic.Name).value);
  for (const n of ['Slow Flames', 'Normal Flames', 'Fast Flames', 'Crackle Low', 'Crackle Medium', 'Crackle High',
    'Flame Style 1', 'Flame Style 2', 'Flame Style 3']) {
    assert.ok(effects.includes(n), n);
  }
  assert.ok(!acc['Flame Effects'].services.some((s) => s.UUID === hap.Service.Fanv2.UUID), 'no fan controls');
  const heat = acc['Fireplace Heat'].services.map((s) => s.getCharacteristic(hap.Characteristic.Name).value);
  for (const n of ['Fireplace Heat', 'Fan Only', 'Low Heat', 'High Heat']) {
    assert.ok(heat.includes(n), n);
  }
});

test('lights and effects can never turn the fireplace on', { skip }, async (t) => {
  const { acc, device, writes } = await setup(OFF_STATE);
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const L = acc['Fireplace Lights'];
  const E = acc['Flame Effects'];
  await set(svc(L, 'flames'), C.On, true);
  await set(svc(L, 'ember'), C.On, true);
  await set(svc(L, 'ember'), C.Brightness, 80);
  await set(svc(L, 'downlight'), C.On, true);
  await set(svc(E, 'speed-fast'), C.On, true);
  await set(svc(E, 'crackle-high'), C.On, true);
  await set(svc(E, 'style-2'), C.On, true);
  await sleep(400);
  assert.deepEqual(writes, [], 'no writes at all');
  assert.equal(device.state['1'], false);
  // Tiles revert to off.
  assert.equal(svc(L, 'flames').getCharacteristic(C.On).value, false);
  assert.equal(svc(L, 'ember').getCharacteristic(C.On).value, false);
  assert.equal(svc(E, 'style-2').getCharacteristic(C.On).value, false);
});

test('colors changed while off are queued, then applied when the fireplace turns on', { skip }, async (t) => {
  const { acc, device, writes } = await setup(OFF_STATE);
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const flames = svc(acc['Fireplace Lights'], 'flames');
  await Promise.all([set(flames, C.Hue, 230), set(flames, C.Saturation, 100)]);
  await sleep(300);
  assert.deepEqual(writes, []);
  assert.equal(await get(flames, C.Hue), 225, 'reports the snapped, queued color');
  // Fireplace turned on from the remote.
  device._onData({ dps: { 1: true } });
  await sleep(1700);
  assert.deepEqual(writes, [{ 102: 'BLUE' }]);
});

test('Fireplace switch only writes DP1', { skip }, async (t) => {
  const { acc, device, writes } = await setup(OFF_STATE);
  t.after(() => device.stop());
  await set(svc(acc.Fireplace, 'switch 1'), hap.Characteristic.On, true);
  await sleep(50);
  assert.deepEqual(writes, [{ 1: true }]);
});

test('heat on powers the unit on, then sets the remembered level; off leaves the flame on', { skip }, async (t) => {
  const { acc, device, writes } = await setup(OFF_STATE);
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const heat = svc(acc['Fireplace Heat'], 'heat');
  await Promise.all([set(heat, C.Active, 1), set(heat, C.RotationSpeed, 3)]);
  await sleep(200);
  assert.deepEqual(writes, [{ 1: true }, { 113: 'HIGH_HEAT' }]);
  assert.equal(await get(heat, C.CurrentHeaterCoolerState), C.CurrentHeaterCoolerState.HEATING);
  await set(heat, C.Active, 0);
  await sleep(200);
  assert.deepEqual(writes[2], { 113: 'OFF' });
  assert.equal(device.state['1'], true, 'flame still on');
  // Next time it comes back at high heat.
  await set(heat, C.Active, 1);
  await sleep(200);
  assert.deepEqual(writes[3], { 113: 'HIGH_HEAT' });
  // Speed 1 = fan only, shown as idle.
  await set(heat, C.RotationSpeed, 1);
  await sleep(200);
  assert.deepEqual(writes[4], { 113: 'FAN' });
  assert.equal(await get(heat, C.CurrentHeaterCoolerState), C.CurrentHeaterCoolerState.IDLE);
});

test('target temperature snaps to even °F and reports back', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const heat = svc(acc['Fireplace Heat'], 'heat');
  await set(heat, C.HeatingThresholdTemperature, 23.9); // 75.02 °F
  await sleep(250);
  assert.deepEqual(writes, [{ 10: 76 }]);
  // 76 °F = 24.4 °C (HAP's 0.1 step rounding can add float noise).
  assert.ok(Math.abs(await get(heat, C.HeatingThresholdTemperature) - 24.4) < 1e-6);
  assert.ok(Math.abs(await get(heat, C.CurrentTemperature) - 24.4) < 1e-6);
});

test('ember bed: off remembers the level, on restores it, palette snapping', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const ember = svc(acc['Fireplace Lights'], 'ember');
  await set(ember, C.On, false);
  await sleep(200);
  assert.deepEqual(writes, [{ 110: 0 }]);
  assert.equal(await get(ember, C.Brightness), 60);
  await set(ember, C.On, true);
  await sleep(200);
  assert.deepEqual(writes[1], { 110: 60 });
  await Promise.all([set(ember, C.Hue, 350), set(ember, C.Saturation, 45)]);
  await sleep(200);
  assert.deepEqual(writes[2], { 109: '10' });
  assert.equal(await get(ember, C.Hue), 340);
});

test('turning Flames off turns the fireplace off without zeroing the other lights', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true, 106: 40 });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const L = acc['Fireplace Lights'];
  // Tapping the grouped tile sends Off to all three.
  await Promise.all([
    set(svc(L, 'flames'), C.On, false),
    set(svc(L, 'ember'), C.On, false),
    set(svc(L, 'downlight'), C.On, false),
  ]);
  await sleep(300);
  assert.deepEqual(writes, [{ 1: false }]);
});

test('flame styles behave like radio buttons', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const E = acc['Flame Effects'];
  await set(svc(E, 'style-3'), C.On, true);
  await sleep(300);
  assert.deepEqual(writes, [{ 101: 'THREE' }]);
  assert.equal(svc(E, 'style-1').getCharacteristic(C.On).value, false);
  assert.equal(svc(E, 'style-3').getCharacteristic(C.On).value, true);
  await set(svc(E, 'style-3'), C.On, false);
  await sleep(400);
  assert.equal(writes.length, 1, 'turning the selected style off does nothing');
  assert.equal(svc(E, 'style-3').getCharacteristic(C.On).value, true);
});

test('crackle switches: pick a level, turn the lit one off for silence', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const E = acc['Flame Effects'];
  await set(svc(E, 'crackle-medium'), C.On, true);
  await sleep(250);
  assert.deepEqual(writes, [{ 104: 'MEDIUM' }]);
  assert.equal(svc(E, 'crackle-medium').getCharacteristic(C.On).value, true);
  await set(svc(E, 'crackle-high'), C.On, true);
  await sleep(250);
  assert.deepEqual(writes[1], { 104: 'HIGH' });
  assert.equal(svc(E, 'crackle-medium').getCharacteristic(C.On).value, false);
  await set(svc(E, 'crackle-high'), C.On, false);
  await sleep(250);
  assert.deepEqual(writes[2], { 104: 'OFF' });
  assert.ok(['crackle-low', 'crackle-medium', 'crackle-high'].every((st) => !svc(E, st).getCharacteristic(C.On).value));
});

test('flame speed switches: one always selected', { skip }, async (t) => {
  const { acc, device, writes } = await setup({ ...OFF_STATE, 1: true });
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const E = acc['Flame Effects'];
  await set(svc(E, 'speed-fast'), C.On, true);
  await sleep(250);
  assert.deepEqual(writes, [{ 103: 'FAST' }]);
  await set(svc(E, 'speed-fast'), C.On, false);
  await sleep(400);
  assert.equal(writes.length, 1);
  assert.equal(svc(E, 'speed-fast').getCharacteristic(C.On).value, true);
});

test('heat level switches: Low Heat from off powers on and heats; turning it off stops heat only', { skip }, async (t) => {
  const { acc, device, writes } = await setup(OFF_STATE);
  t.after(() => device.stop());
  const C = hap.Characteristic;
  const H = acc['Fireplace Heat'];
  await set(svc(H, 'heat-low_heat'), C.On, true);
  await sleep(250);
  assert.deepEqual(writes, [{ 1: true }, { 113: 'LOW_HEAT' }]);
  assert.equal(svc(H, 'heat-low_heat').getCharacteristic(C.On).value, true);
  await set(svc(H, 'heat-high_heat'), C.On, true);
  await sleep(250);
  assert.deepEqual(writes[2], { 113: 'HIGH_HEAT' });
  assert.equal(svc(H, 'heat-low_heat').getCharacteristic(C.On).value, false);
  await set(svc(H, 'heat-high_heat'), C.On, false);
  await sleep(250);
  assert.deepEqual(writes[3], { 113: 'OFF' });
  assert.equal(device.state['1'], true);
});

test('unreachable fireplace reports No Response instead of stale values', { skip }, async (t) => {
  const { acc, device } = await setup(OFF_STATE);
  t.after(() => device.stop());
  device._connected = false;
  const sw = svc(acc.Fireplace, 'switch 1');
  // HAP-NodeJS rejects with the bare status code, which the Home app shows as No Response.
  const noResponse = (e) => e === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
  await assert.rejects(() => get(sw, hap.Characteristic.On), noResponse);
  await assert.rejects(() => set(sw, hap.Characteristic.On, true), noResponse);
  await assert.rejects(() => get(svc(acc['Fireplace Lights'], 'ember'), hap.Characteristic.Brightness), noResponse);
});

test('no log line ever contains the local key', { skip }, async (t) => {
  const { acc, device, log } = await setup(OFF_STATE);
  t.after(() => device.stop());
  await set(svc(acc.Fireplace, 'switch 1'), hap.Characteristic.On, true);
  await sleep(100);
  assert.ok(log.lines.every(([, l]) => !l.includes(KEY_PLACEHOLDER)));
});

test('tile names follow the configured name', { skip }, async (t) => {
  const { acc, device } = await setup(OFF_STATE, { name: 'Den Fireplace', model: 'Orion Slim' });
  t.after(() => device.stop());
  assert.deepEqual(Object.keys(acc).sort(), ['Den Fireplace', 'Den Fireplace Heat', 'Den Fireplace Lights', 'Flame Effects']);
  const sw = svc(acc['Den Fireplace'], 'switch 1');
  assert.equal(sw.getCharacteristic(hap.Characteristic.ConfiguredName).value, 'Den Fireplace');
  const info = acc['Den Fireplace'].getService(hap.Service.AccessoryInformation);
  assert.equal(info.getCharacteristic(hap.Characteristic.Model).value, 'Orion Slim');
});

test('warns once when the fireplace does not report data points a shown tile needs', { skip }, async (t) => {
  const partial = { ...OFF_STATE };
  delete partial[104];
  delete partial[113];
  const { device, log } = await setup(partial);
  t.after(() => device.stop());
  const warns = log.lines.filter(([lvl]) => lvl === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /heat \(DP 113\)/);
  assert.match(warns[0][1], /effects \(DP 104\)/);
});

test('no data point warning for a fully reporting fireplace', { skip }, async (t) => {
  const { log, device } = await setup(OFF_STATE);
  t.after(() => device.stop());
  assert.deepEqual(log.lines.filter(([lvl]) => lvl === 'warn'), []);
});

test('bad settings are logged, not thrown, and nothing is started', () => {
  const api = new EventEmitter();
  const log = makeLog();
  assert.doesNotThrow(() => new ModernFlamesPlatform(log, { deviceId: 'x', ip: '10.0.0.2', key: 'short' }, api));
  assert.equal(api.listenerCount('didFinishLaunching'), 0);
  assert.match(log.lines[0][1], /16 characters/);
  assert.ok(!log.lines[0][1].includes('short'), 'the key itself is not logged');
});
