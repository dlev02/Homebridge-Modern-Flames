'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FireplaceDevice } = require('../lib/device');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDevice({ reply = true, slowMs = 30 } = {}) {
  const dev = new FireplaceDevice({ id: 'x', ip: '127.0.0.1', key: 'k'.repeat(16), version: '3.3' }, quiet);
  const writes = [];
  dev.tuya.set = async ({ data }) => {
    writes.push({ ...data });
    await sleep(slowMs);
    Object.assign(dev.state, data); // the device applies it
    if (!reply) {
      throw new Error('Timeout waiting for status response');
    }
    return { dps: data };
  };
  dev.tuya.get = async () => ({ dps: { ...dev.state } });
  dev._connected = true;
  dev._onData({ dps: { 1: true, 110: 50 } });
  return { dev, writes };
}

test('slider drags coalesce: queued writes merge, latest value wins', async () => {
  const { dev, writes } = makeDevice();
  // A burst in the same instant becomes one write.
  await Promise.all([10, 20, 30].map((v) => dev.set({ 110: v })));
  assert.deepEqual(writes, [{ 110: 30 }]);
  // Values arriving while a write is in flight merge into the next one.
  const first = dev.set({ 110: 40 });
  await sleep(5);
  const rest = [50, 60, 70].map((v) => dev.set({ 110: v }));
  await Promise.all([first, ...rest]);
  assert.deepEqual(writes.slice(1), [{ 110: 40 }, { 110: 70 }]);
  assert.equal(dev.state['110'], 70);
});

test('a command the device applied without replying is confirmed by a status read', async () => {
  const { dev, writes } = makeDevice({ reply: false });
  await dev.set({ 110: 75 });
  assert.deepEqual(writes, [{ 110: 75 }]);
  assert.equal(dev.state['110'], 75);
});

test('a command the device really ignored still fails', async () => {
  const { dev } = makeDevice({ reply: false });
  dev.tuya.set = async () => {
    throw new Error('Timeout waiting for status response');
  };
  await assert.rejects(() => dev.set({ 110: 75 }), /Timeout/);
});

test('blocked data points are refused before anything is sent', async () => {
  const { dev, writes } = makeDevice();
  assert.throws(() => dev.set({ 121: true }), /Refusing/);
  assert.deepEqual(writes, []);
});
