'use strict';

const { FireplaceDevice } = require('./device');
const { PowerAccessory, HeatAccessory, LightsAccessory, EffectsAccessory } = require('./accessories');
const { missingDps } = require('./mapping');

const PLUGIN_NAME = 'homebridge-modern-flames';
const PLATFORM_NAME = 'ModernFlames';
const DEFAULT_NAME = 'Fireplace';

/** Returns a list of problems with the device settings (empty when they look usable). */
function configProblems(config) {
  const problems = [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!str(config.deviceId)) {
    problems.push('Device ID is missing');
  }
  if (!str(config.ip)) {
    problems.push('IP address is missing');
  }
  const key = str(config.key);
  if (!key) {
    problems.push('Local key is missing');
  } else if (key.length !== 16) {
    problems.push(`Local key must be 16 characters (it is ${key.length})`);
  }
  return problems;
}

class ModernFlamesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.version = require('../package.json').version;
    this.cached = new Map();
    this.handlers = [];
    this.cosmeticWhileOff = this.config.cosmeticWhileOff === 'send' ? 'send' : 'queue';
    this.name = (typeof this.config.name === 'string' && this.config.name.trim()) || DEFAULT_NAME;
    this.model = (typeof this.config.model === 'string' && this.config.model.trim()) || 'Electric Fireplace';

    const problems = configProblems(this.config);
    if (problems.length) {
      this.log.error(`${problems.join('. ')}. Open the plugin settings to fix this; the fireplace will not be added until then.`);
      return;
    }

    this.api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (err) {
        this.log.error(`Could not set up the fireplace: ${err.message}`);
      }
    });
    this.api.on('shutdown', () => {
      if (this.device) {
        this.device.stop();
      }
    });
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  setup() {
    const { hap } = this.api;
    const deviceId = this.config.deviceId.trim();
    this.device = new FireplaceDevice({
      id: deviceId,
      ip: this.config.ip.trim(),
      key: this.config.key.trim(),
      version: this.config.protocolVersion || '3.3',
    }, this.log);

    const specs = [
      {
        kind: 'power',
        // Same UUID homebridge-tuya / homebridge-tuya-plus use for this device, so a fireplace
        // moved over from those plugins (on the same bridge) keeps its tile, room and name.
        uuid: hap.uuid.generate(`homebridge-tuya:${deviceId}`),
        name: this.name,
        category: hap.Categories.SWITCH,
        Handler: PowerAccessory,
        enabled: true,
      },
      {
        kind: 'heat',
        uuid: hap.uuid.generate(`${PLUGIN_NAME}:${deviceId}:heat`),
        name: `${this.name} Heat`,
        category: hap.Categories.AIR_HEATER,
        Handler: HeatAccessory,
        enabled: !this.config.hideHeat,
      },
      {
        kind: 'lights',
        uuid: hap.uuid.generate(`${PLUGIN_NAME}:${deviceId}:lights`),
        name: `${this.name} Lights`,
        category: hap.Categories.LIGHTBULB,
        Handler: LightsAccessory,
        enabled: !this.config.hideLights,
      },
      {
        kind: 'effects',
        uuid: hap.uuid.generate(`${PLUGIN_NAME}:${deviceId}:effects`),
        name: 'Flame Effects',
        category: hap.Categories.FAN,
        Handler: EffectsAccessory,
        enabled: !this.config.hideEffects,
      },
    ];

    const toRegister = [];
    const wanted = new Set();
    for (const spec of specs) {
      if (!spec.enabled) {
        continue;
      }
      wanted.add(spec.uuid);
      let accessory = this.cached.get(spec.uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(spec.name, spec.uuid, spec.category);
      }
      accessory.context.kind = spec.kind;
      this.handlers.push(new spec.Handler(this, accessory));
      if (isNew) {
        toRegister.push(accessory);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }
    if (toRegister.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);
    }

    const stale = [...this.cached.values()].filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing hidden accessories: ${stale.map((a) => a.displayName).join(', ')}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.device.on('update', () => this.handlers.forEach((h) => h.refresh()));
    this.device.on('reachable', () => {
      this.checkDataPoints();
      this.handlers.forEach((h) => h.refresh());
    });
    this.device.on('unreachable', () => this.handlers.forEach((h) => h.markUnreachable()));

    if (this.cosmeticWhileOff === 'queue') {
      this.log.debug('Color/effect changes made while the fireplace is off are queued until it turns on.');
    }
    this.device.start();
  }

  /** Once per start: warn if this fireplace model does not report data points the shown tiles use. */
  checkDataPoints() {
    if (this._checkedDps) {
      return;
    }
    this._checkedDps = true;
    const c = this.config;
    const tiles = ['power'];
    if (!c.hideHeat) {
      tiles.push('heat');
    }
    if (!c.hideLights) {
      tiles.push('lights');
      if (c.showColorCycle) {
        tiles.push('colorCycle');
      }
    }
    if (!c.hideEffects) {
      tiles.push('effects');
      if (!c.hideFlameStyles) {
        tiles.push('flameStyles');
      }
    }
    const missing = missingDps(this.device.state, tiles);
    this.log.debug(`Data points reported: ${Object.keys(this.device.state).join(', ')}`);
    if (missing.length) {
      this.log.warn(`This fireplace has not reported some data points the plugin expects: ${
        missing.map((m) => `${m.tile} (DP ${m.dps.join(', ')})`).join('; ')
      }. Those controls may not work on this model. Hide them in the plugin settings, or open an issue with your debug log.`);
    }
  }
}

module.exports = { ModernFlamesPlatform, PLUGIN_NAME, PLATFORM_NAME, configProblems };
