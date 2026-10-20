'use strict';

/**
 * Optional one-time migration from homebridge-tuya / homebridge-tuya-plus ("TuyaLan" platform).
 *
 * Replaces a TuyaLan platform entry that holds only the fireplace with a "ModernFlames" entry for
 * the same device. Its _bridge block is kept, so a child bridge keeps its HomeKit pairing, and the
 * Fireplace tile keeps its room and name (this plugin reuses the homebridge-tuya accessory ID).
 * The local key is copied over without being printed.
 *
 * Usage (stop Homebridge first):
 *   node migrate-from-tuya-plus.js [path/to/config.json] [--id <tuya device id>]
 *
 * The config path defaults to ~/.homebridge/config.json. A timestamped backup is written next to it.
 * If the TuyaLan entry has other devices too, nothing is changed: move the fireplace by hand.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
let wantId = null;
const idAt = args.indexOf('--id');
if (idAt >= 0) {
  wantId = args[idAt + 1];
  args.splice(idAt, 2);
}
const file = args[0] || path.join(os.homedir(), '.homebridge', 'config.json');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(raw);
const platforms = Array.isArray(cfg.platforms) ? cfg.platforms : [];

const candidates = [];
platforms.forEach((p, i) => {
  if (p && p.platform === 'TuyaLan' && Array.isArray(p.devices)) {
    p.devices.forEach((d) => {
      if (!wantId || (d && d.id === wantId)) {
        candidates.push({ i, d });
      }
    });
  }
});

if (candidates.length === 0) {
  fail(wantId ? `No TuyaLan device with id ${wantId} found in ${file}.` : `No TuyaLan platform entry found in ${file} (already migrated?).`);
}
if (candidates.length > 1) {
  fail(`Found ${candidates.length} TuyaLan devices. Run again with --id <device id> for the fireplace:\n${
    candidates.map(({ d }) => `  ${d.id}  ${d.name || ''}`).join('\n')}`);
}

const { i, d } = candidates[0];
const old = platforms[i];
if (old.devices.length !== 1) {
  fail('That TuyaLan entry also controls other devices. Nothing was changed: add a ModernFlames entry and remove the fireplace from TuyaLan by hand.');
}
if (!d.id || !d.ip || !d.key) {
  fail('The TuyaLan device entry is missing its id, ip or key. Nothing was changed.');
}

const othersBefore = JSON.stringify(platforms.filter((_, j) => j !== i));
const bridgeBefore = JSON.stringify(old._bridge);
const mainBefore = JSON.stringify(cfg.bridge);
const accessoriesBefore = JSON.stringify(cfg.accessories);

const entry = {
  platform: 'ModernFlames',
  name: 'Fireplace',
  deviceId: d.id,
  ip: d.ip,
  key: d.key,
  protocolVersion: String(d.version || '3.3'),
};
if (old._bridge) {
  entry._bridge = old._bridge;
}
platforms[i] = entry;

const out = JSON.stringify(cfg, null, 4);
const check = JSON.parse(out);
if (JSON.stringify(check.platforms.filter((_, j) => j !== i)) !== othersBefore) {
  fail('Other platforms would change; aborting.');
}
if (JSON.stringify(check.platforms[i]._bridge) !== bridgeBefore) {
  fail('_bridge would change; aborting.');
}
if (JSON.stringify(check.bridge) !== mainBefore || JSON.stringify(check.accessories) !== accessoriesBefore) {
  fail('Main bridge or accessories would change; aborting.');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${file}.bak-${stamp}`;
fs.writeFileSync(backup, raw);
fs.writeFileSync(`${file}.tmp`, out);
fs.renameSync(`${file}.tmp`, file);

console.log(`Migrated device ${d.id} to ModernFlames. Backup: ${backup}`);
console.log(old._bridge
  ? `Kept child bridge "${old._bridge.name || ''}" ${old._bridge.username} (pairing unchanged).`
  : 'The fireplace stays on the main bridge.');
console.log('Uninstall homebridge-tuya / homebridge-tuya-plus if nothing else uses it, then start Homebridge.');
