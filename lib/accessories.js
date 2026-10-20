'use strict';

const M = require('./mapping');

const { DP } = M;

/**
 * Collects characteristic writes that HomeKit sends together (On + Brightness, Hue + Saturation,
 * Active + RotationSpeed) and applies them as one decision.
 */
class Batch {
  constructor(apply, delayMs = 80) {
    this.apply = apply;
    this.delayMs = delayMs;
    this.values = {};
    this.promise = null;
  }

  add(key, value) {
    this.values[key] = value;
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => {
        setTimeout(() => {
          const values = this.values;
          this.values = {};
          this.promise = null;
          Promise.resolve()
            .then(() => this.apply(values))
            .then(resolve, reject);
        }, this.delayMs);
      });
    }
    return this.promise;
  }
}

class BaseAccessory {
  constructor(platform, accessory) {
    this.platform = platform;
    this.accessory = accessory;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.device = platform.device;
    this.log = platform.log;
    this.cosmeticWhileOff = platform.cosmeticWhileOff;
    this.ctx = accessory.context;
    this.ctx.names = this.ctx.names || {};
    this.tracked = new Set();
    this._refreshTimer = null;

    const { Service, Characteristic } = this.hap;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Modern Flames')
      .setCharacteristic(Characteristic.Model, platform.model)
      .setCharacteristic(Characteristic.SerialNumber, `${this.device.id}-${accessory.context.kind || 'x'}`)
      .setCharacteristic(Characteristic.FirmwareRevision, platform.version);
  }

  /** Get or create a named service, with Name + ConfiguredName (user renames are kept). */
  service(Type, defaultName, subtype) {
    const { Characteristic } = this.hap;
    let svc = this.accessory.getServiceById(Type, subtype);
    if (!svc) {
      svc = this.accessory.addService(Type, defaultName, subtype);
    }
    this.tracked.add(svc);
    svc.setCharacteristic(Characteristic.Name, defaultName);
    if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    svc.getCharacteristic(Characteristic.ConfiguredName)
      .onGet(() => this.ctx.names[subtype] || defaultName)
      .onSet((value) => {
        const name = String(value || '').trim();
        if (name && name !== defaultName) {
          this.ctx.names[subtype] = name;
        } else {
          delete this.ctx.names[subtype];
        }
        this.api.updatePlatformAccessories([this.accessory]);
      });
    svc.updateCharacteristic(Characteristic.ConfiguredName, this.ctx.names[subtype] || defaultName);
    return svc;
  }

  /** Give a service a ServiceLabelIndex (needs a ServiceLabel service on the accessory). */
  labelIndex(svc, index) {
    const { Characteristic } = this.hap;
    if (!svc.testCharacteristic(Characteristic.ServiceLabelIndex)) {
      svc.addOptionalCharacteristic(Characteristic.ServiceLabelIndex);
    }
    svc.getCharacteristic(Characteristic.ServiceLabelIndex).updateValue(index);
  }

  addServiceLabel() {
    const { Service, Characteristic } = this.hap;
    const svc = this.accessory.getService(Service.ServiceLabel) || this.accessory.addService(Service.ServiceLabel);
    svc.setCharacteristic(Characteristic.ServiceLabelNamespace, Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);
    this.tracked.add(svc);
    return svc;
  }

  /** Remove services from an older layout (e.g. a toggle was switched off). */
  pruneServices() {
    const { Service } = this.hap;
    for (const svc of [...this.accessory.services]) {
      if (svc.UUID === Service.AccessoryInformation.UUID || this.tracked.has(svc)) {
        continue;
      }
      this.accessory.removeService(svc);
    }
  }

  commFailure() {
    return new this.api.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  /** Wrap a getter: No Response while the fireplace is unreachable. */
  getter(fn) {
    return () => {
      if (!this.device.reachable) {
        throw this.commFailure();
      }
      return fn();
    };
  }

  /** Wrap a setter: No Response while unreachable, and on failed writes. */
  setter(fn) {
    return async (value) => {
      if (!this.device.reachable) {
        throw this.commFailure();
      }
      try {
        await fn(value);
      } catch (err) {
        this.log.warn(`${this.accessory.displayName}: command failed: ${err.message}`);
        this.refreshSoon();
        throw this.commFailure();
      }
    };
  }

  /** Re-push every value from device state (also used to revert refused changes). */
  refreshSoon(ms = 300) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), ms);
  }

  refuse(what) {
    this.log.info(`${what} ignored: the fireplace is off. Turn on "${this.platform.name}" first.`);
    this.refreshSoon();
  }

  /**
   * Cosmetic write: sent while on; while off it is queued (or sent if the live test
   * showed it is safe), unless it would turn something on, which is refused.
   * Returns true if handled (sent or queued), false if refused.
   */
  async cosmetic(dps, { turnsSomethingOn = false, label }) {
    const action = M.gateCosmeticWrite({
      powerOn: this.device.powerOn,
      turnsSomethingOn,
      cosmeticWhileOff: this.cosmeticWhileOff,
    });
    if (action === 'refuse') {
      this.refuse(label);
      return false;
    }
    if (action === 'queue') {
      this.log.info(`${label}: saved, will apply when the fireplace turns on.`);
      this.device.queue(dps);
      return true;
    }
    this.log.info(label);
    await this.device.set(dps);
    return true;
  }

  markUnreachable() {
    const err = this.commFailure();
    for (const svc of this.tracked) {
      for (const c of svc.characteristics) {
        if (c.UUID === this.hap.Characteristic.On.UUID || c.UUID === this.hap.Characteristic.Active.UUID) {
          c.updateValue(err);
        }
      }
    }
  }

  refresh() {}
}

// ---------------------------------------------------------------------------------------------

/** "Fireplace": power only (DP1). Same "switch 1" service as homebridge-tuya, so a migrated tile is kept. */
class PowerAccessory extends BaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory);
    const { Service, Characteristic } = this.hap;
    this.sw = this.service(Service.Switch, platform.name, 'switch 1');
    this.sw.setPrimaryService(true);
    this.sw.getCharacteristic(Characteristic.On)
      .onGet(this.getter(() => this.device.powerOn))
      .onSet(this.setter(async (v) => {
        const on = Boolean(v);
        if (on === this.device.powerOn) {
          return;
        }
        this.log.info(`Fireplace: turning ${on ? 'on' : 'off'}`);
        await this.device.set({ [DP.POWER]: on });
      }));
    this.pruneServices();
  }

  refresh() {
    if (!this.device.reachable) {
      return;
    }
    this.sw.updateCharacteristic(this.hap.Characteristic.On, this.device.powerOn);
  }
}

// ---------------------------------------------------------------------------------------------

/** "Fireplace Heat": HeaterCooler, heat only. Speed 1/2/3 = Fan only / Low heat / High heat. */
class HeatAccessory extends BaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory);
    const { Service, Characteristic } = this.hap;
    const C = Characteristic;
    this.ctx.lastHeat = this.ctx.lastHeat || 'LOW_HEAT';

    const s = this.service(Service.HeaterCooler, `${platform.name} Heat`, 'heat');
    this.svc = s;
    s.setPrimaryService(true);
    this.batch = new Batch((p) => this.applyHeat(p));

    s.getCharacteristic(C.Active)
      .onGet(this.getter(() => (this.heatActive() ? 1 : 0)))
      .onSet(this.setter((v) => this.batch.add('active', Number(v))));

    s.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(this.getter(() => this.currentState()));

    const target = s.getCharacteristic(C.TargetHeaterCoolerState);
    target.updateValue(C.TargetHeaterCoolerState.HEAT);
    target.setProps({
      minValue: C.TargetHeaterCoolerState.HEAT,
      maxValue: C.TargetHeaterCoolerState.HEAT,
      validValues: [C.TargetHeaterCoolerState.HEAT],
    });
    target.onGet(this.getter(() => C.TargetHeaterCoolerState.HEAT))
      .onSet(this.setter(() => undefined));

    s.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3, minStep: 1 })
      .onGet(this.getter(() => this.speed()))
      .onSet(this.setter((v) => this.batch.add('speed', Number(v))));

    s.getCharacteristic(C.HeatingThresholdTemperature)
      .updateValue(20)
      .setProps({ minValue: 20, maxValue: 32.5, minStep: 0.1 })
      .onGet(this.getter(() => this.targetC()))
      .onSet(this.setter((v) => this.setTarget(Number(v))));

    // No room sensor on this fireplace: report the set point (see README).
    s.getCharacteristic(C.CurrentTemperature)
      .onGet(this.getter(() => this.targetC()));

    // Plain-language level switches next to the heater control (the heater's speed slider shows %).
    this.addServiceLabel();
    this.labelIndex(s, 1);
    this.levelSwitches = [['FAN', 'Fan Only'], ['LOW_HEAT', 'Low Heat'], ['HIGH_HEAT', 'High Heat']].map(([value, name], i) => {
      const sw = this.service(Service.Switch, name, `heat-${value.toLowerCase()}`);
      this.labelIndex(sw, 2 + i);
      s.addLinkedService(sw);
      sw.getCharacteristic(C.On)
        .onGet(this.getter(() => this.heatActive() && this.heatLevel() === value))
        .onSet(this.setter((v) => {
          if (v) {
            return this.batch.add('switch', value);
          }
          if (this.heatActive() && this.heatLevel() === value) {
            return this.batch.add('switch', 'OFF');
          }
          this.refreshSoon();
          return undefined;
        }));
      return { sw, value };
    });

    this.pruneServices();
  }

  heatLevel() {
    return this.device.state[DP.HEAT_LEVEL];
  }

  heatActive() {
    const lvl = this.heatLevel();
    return this.device.powerOn && typeof lvl === 'string' && lvl !== 'OFF';
  }

  currentState() {
    const S = this.hap.Characteristic.CurrentHeaterCoolerState;
    if (!this.heatActive()) {
      return S.INACTIVE;
    }
    return this.heatLevel() === 'FAN' ? S.IDLE : S.HEATING;
  }

  speed() {
    const lvl = this.heatActive() ? this.heatLevel() : this.ctx.lastHeat;
    return M.enumToSpeed(M.HEAT_LEVELS, lvl) || 2;
  }

  usesCelsius() {
    return this.device.state[DP.TEMP_UNIT] === 'c';
  }

  /** Set point in °C at HomeKit's 0.1 precision. */
  targetC() {
    const raw = this.usesCelsius()
      ? Number(this.device.value(DP.TEMP_SET_C))
      : M.fToC(Number(this.device.value(DP.TEMP_SET_F)));
    if (!Number.isFinite(raw)) {
      return 20;
    }
    return Math.round(Math.max(20, Math.min(32.5, raw)) * 10) / 10;
  }

  async applyHeat(p) {
    let target;
    const source = Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ');
    if (p.switch !== undefined) {
      // A level switch overrides anything else in the same gesture.
      p = p.switch === 'OFF' ? { active: 0 } : { active: 1, speed: M.enumToSpeed(M.HEAT_LEVELS, p.switch) };
    }
    const level = p.speed !== undefined ? M.speedToEnum(M.HEAT_LEVELS, p.speed) : undefined;
    if (level) {
      this.ctx.lastHeat = level;
    }
    if (p.active === 0 || level === null) {
      target = 'OFF';
    } else if (p.active === 1) {
      target = level || this.ctx.lastHeat || 'LOW_HEAT';
    } else if (level) {
      if (!this.heatActive()) {
        // Speed picked while heat is off: remember it for the next time heat is turned on.
        this.refreshSoon();
        return;
      }
      target = level;
    } else {
      return;
    }

    if (target === 'OFF') {
      if (this.heatActive()) {
        this.log.info(`Fireplace Heat: off, flame keeps running (from Home: ${source})`);
        await this.device.set({ [DP.HEAT_LEVEL]: 'OFF' });
      }
      this.refreshSoon();
      return;
    }

    // The one deliberate exception: turning heat on may power the fireplace on.
    if (!this.device.powerOn) {
      this.log.info('Fireplace Heat: turning the fireplace on for heat');
      await this.device.set({ [DP.POWER]: true });
      await this.device.waitFor(DP.POWER, true, 5000);
    }
    if (this.heatLevel() !== target) {
      this.log.info(`Fireplace Heat: ${this.levelLabel(target)} (from Home: ${source})`);
      await this.device.set({ [DP.HEAT_LEVEL]: target });
    }
    this.refreshSoon();
  }

  levelLabel(level) {
    return { FAN: 'fan only', LOW_HEAT: 'low heat', HIGH_HEAT: 'high heat', OFF: 'off' }[level] || level;
  }

  async setTarget(c) {
    let dps;
    let label;
    if (this.usesCelsius()) {
      const dc = M.celsiusToDeviceC(c);
      dps = { [DP.TEMP_SET_C]: dc };
      label = `Fireplace Heat: target ${dc} °C`;
    } else {
      const f = M.celsiusToDeviceF(c);
      dps = { [DP.TEMP_SET_F]: f };
      label = `Fireplace Heat: target ${f} °F`;
    }
    const key = Object.keys(dps)[0];
    if (this.device.value(key) !== dps[key]) {
      await this.cosmetic(dps, { label });
    }
    // Report the snapped value back.
    this.refreshSoon(150);
  }

  refresh() {
    if (!this.device.reachable) {
      return;
    }
    const C = this.hap.Characteristic;
    this.svc.updateCharacteristic(C.Active, this.heatActive() ? 1 : 0);
    this.svc.updateCharacteristic(C.CurrentHeaterCoolerState, this.currentState());
    this.svc.updateCharacteristic(C.TargetHeaterCoolerState, C.TargetHeaterCoolerState.HEAT);
    this.svc.updateCharacteristic(C.RotationSpeed, this.speed());
    this.svc.updateCharacteristic(C.HeatingThresholdTemperature, this.targetC());
    this.svc.updateCharacteristic(C.CurrentTemperature, this.targetC());
    for (const { sw, value } of this.levelSwitches) {
      sw.updateCharacteristic(C.On, this.heatActive() && this.heatLevel() === value);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** "Fireplace Lights": Flames, Ember Bed and Downlight in one tile, plus optional color cycle switches. */
class LightsAccessory extends BaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory);
    const { Service, Characteristic: C } = this.hap;

    this.addServiceLabel();

    // Flames
    const flames = this.service(Service.Lightbulb, 'Flames', 'flames');
    this.flames = flames;
    flames.setPrimaryService(true);
    this.labelIndex(flames, 1);
    this.flamesBatch = new Batch((p) => this.applyFlames(p));
    flames.getCharacteristic(C.On)
      .onGet(this.getter(() => this.device.powerOn))
      .onSet(this.setter((v) => {
        if (!v) {
          // Remember that this gesture powers the fireplace off, so the Ember Bed and
          // Downlight keep their levels instead of being written to 0 alongside it.
          this.powerOffRequestedAt = Date.now();
        }
        return this.flamesBatch.add('on', Boolean(v));
      }));
    flames.getCharacteristic(C.Hue)
      .onGet(this.getter(() => this.flameColor().hue))
      .onSet(this.setter((v) => this.flamesBatch.add('hue', Number(v))));
    flames.getCharacteristic(C.Saturation)
      .onGet(this.getter(() => this.flameColor().sat))
      .onSet(this.setter((v) => this.flamesBatch.add('sat', Number(v))));

    // Ember bed and downlight
    this.ember = this.paletteLight('Ember Bed', 'ember', 2, DP.EMBER_COLOR, DP.EMBER_LEVEL, 'lastEmber');
    this.down = this.paletteLight('Downlight', 'downlight', 3, DP.DOWNLIGHT_COLOR, DP.DOWNLIGHT_LEVEL, 'lastDown');
    flames.addLinkedService(this.ember.svc);
    flames.addLinkedService(this.down.svc);

    // Optional color cycle switches
    this.cycles = [];
    if (platform.config.showColorCycle) {
      this.cycles.push(this.cycleSwitch('Ember Color Cycle', 'ember-cycle', 4, DP.EMBER_CYCLE));
      this.cycles.push(this.cycleSwitch('Downlight Color Cycle', 'downlight-cycle', 5, DP.DOWNLIGHT_CYCLE));
    }

    this.pruneServices();
  }

  flameColor() {
    return M.flameColorByValue(this.device.value(DP.FLAME_COLOR)) || M.FLAME_COLORS[0];
  }

  async applyFlames(p) {
    if (p.on === false) {
      if (this.device.powerOn) {
        this.log.info('Flames turned off: turning the fireplace off');
        await this.device.set({ [DP.POWER]: false });
      }
      this.refreshSoon();
      return;
    }
    if (p.on === true && !this.device.powerOn) {
      this.refuse('Flames on');
      return;
    }
    if (p.hue !== undefined || p.sat !== undefined) {
      const cur = this.flameColor();
      const hue = p.hue !== undefined ? p.hue : cur.hue;
      const sat = p.sat !== undefined ? p.sat : cur.sat;
      const color = M.snapFlameColor(hue, sat);
      if (color.value !== this.device.value(DP.FLAME_COLOR)) {
        await this.cosmetic({ [DP.FLAME_COLOR]: color.value }, { label: `Flames: ${color.name}` });
      }
    }
    // Report the snapped color back.
    this.refreshSoon(150);
  }

  paletteLight(name, subtype, index, colorDp, levelDp, memoKey) {
    const { Service, Characteristic: C } = this.hap;
    const svc = this.service(Service.Lightbulb, name, subtype);
    this.labelIndex(svc, index);
    this.ctx[memoKey] = this.ctx[memoKey] || 100;
    const light = { svc, name, colorDp, levelDp, memoKey };
    light.batch = new Batch((p) => this.applyPalette(light, p));
    light.level = () => Number(this.device.value(levelDp)) || 0;
    light.isOn = () => this.device.powerOn && light.level() > 0;
    light.color = () => M.paletteColorByValue(this.device.value(colorDp)) || M.LIGHT_PALETTE[0];

    svc.getCharacteristic(C.On)
      .onGet(this.getter(() => light.isOn()))
      .onSet(this.setter((v) => light.batch.add('on', Boolean(v))));
    svc.getCharacteristic(C.Brightness)
      .onGet(this.getter(() => (light.level() > 0 ? light.level() : this.ctx[memoKey])))
      .onSet(this.setter((v) => light.batch.add('brightness', Number(v))));
    svc.getCharacteristic(C.Hue)
      .onGet(this.getter(() => light.color().hue))
      .onSet(this.setter((v) => light.batch.add('hue', Number(v))));
    svc.getCharacteristic(C.Saturation)
      .onGet(this.getter(() => light.color().sat))
      .onSet(this.setter((v) => light.batch.add('sat', Number(v))));
    return light;
  }

  async applyPalette(light, p) {
    const turnOff = p.on === false || p.brightness === 0;
    const turnOn = !turnOff && (p.on === true || (p.brightness !== undefined && p.brightness > 0));
    if (turnOn && !this.device.powerOn) {
      this.refuse(`${light.name} on`);
      return;
    }

    const dps = {};
    const labels = [];
    if (turnOff) {
      const poweringOff = Date.now() - (this.powerOffRequestedAt || 0) < 1500;
      if (light.level() > 0) {
        this.ctx[light.memoKey] = light.level();
        if (this.device.powerOn && !poweringOff) {
          dps[light.levelDp] = 0;
          labels.push('off');
        }
      }
    } else if (turnOn) {
      let level = p.brightness !== undefined ? M.clampPercent(p.brightness) : light.level();
      if (level === 0) {
        level = this.ctx[light.memoKey] || 100;
      }
      this.ctx[light.memoKey] = level;
      if (level !== light.level()) {
        dps[light.levelDp] = level;
        labels.push(`${level}%`);
      }
    }
    if (p.hue !== undefined || p.sat !== undefined) {
      const cur = light.color();
      const color = M.snapPaletteColor(p.hue !== undefined ? p.hue : cur.hue, p.sat !== undefined ? p.sat : cur.sat);
      if (color.value !== this.device.value(light.colorDp)) {
        dps[light.colorDp] = color.value;
        labels.push(color.name);
      }
    }
    if (Object.keys(dps).length) {
      await this.cosmetic(dps, { label: `${light.name}: ${labels.join(', ')}` });
    }
    this.refreshSoon(150);
  }

  cycleSwitch(name, subtype, index, dp) {
    const { Service, Characteristic: C } = this.hap;
    const svc = this.service(Service.Switch, name, subtype);
    this.labelIndex(svc, index);
    svc.getCharacteristic(C.On)
      .onGet(this.getter(() => this.device.powerOn && this.device.value(dp) === true))
      .onSet(this.setter(async (v) => {
        const on = Boolean(v);
        if (on === (this.device.value(dp) === true) && this.device.powerOn) {
          return;
        }
        await this.cosmetic({ [dp]: on }, { turnsSomethingOn: on, label: `${name}: ${on ? 'on' : 'off'}` });
        this.refreshSoon(150);
      }));
    return { svc, dp };
  }

  refresh() {
    if (!this.device.reachable) {
      return;
    }
    const C = this.hap.Characteristic;
    const fc = this.flameColor();
    this.flames.updateCharacteristic(C.On, this.device.powerOn);
    this.flames.updateCharacteristic(C.Hue, fc.hue);
    this.flames.updateCharacteristic(C.Saturation, fc.sat);
    for (const light of [this.ember, this.down]) {
      const col = light.color();
      light.svc.updateCharacteristic(C.On, light.isOn());
      light.svc.updateCharacteristic(C.Brightness, light.level() > 0 ? light.level() : this.ctx[light.memoKey]);
      light.svc.updateCharacteristic(C.Hue, col.hue);
      light.svc.updateCharacteristic(C.Saturation, col.sat);
    }
    for (const cyc of this.cycles) {
      cyc.svc.updateCharacteristic(C.On, this.device.powerOn && this.device.value(cyc.dp) === true);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * "Flame Effects": three groups of radio-button switches with plain names.
 *   Slow / Normal / Fast Flames (one is always selected),
 *   Crackle Low / Medium / High (turn the lit one off for silence),
 *   Flame Style 1 / 2 / 3 (one is always selected).
 * Nothing here can turn the fireplace on.
 */
class EffectsAccessory extends BaseAccessory {
  constructor(platform, accessory) {
    super(platform, accessory);
    this.addServiceLabel();
    this.groups = [];
    let index = 1;

    this.groups.push(this.radioGroup({
      dp: DP.FLAME_SPEED,
      label: 'Flame speed',
      options: [['SLOW', 'Slow Flames', 'speed-slow'], ['DEFAULT', 'Normal Flames', 'speed-normal'], ['FAST', 'Fast Flames', 'speed-fast']],
      startIndex: index,
    }));
    index += 3;

    this.groups.push(this.radioGroup({
      dp: DP.CRACKLE,
      label: 'Crackle sound',
      options: [['DEFAULT', 'Crackle Low', 'crackle-low'], ['MEDIUM', 'Crackle Medium', 'crackle-medium'], ['HIGH', 'Crackle High', 'crackle-high']],
      offValue: 'OFF',
      startIndex: index,
    }));
    index += 3;

    if (!platform.config.hideFlameStyles) {
      this.groups.push(this.radioGroup({
        dp: DP.FLAME_STYLE,
        label: 'Flame style',
        options: [['ONE', 'Flame Style 1', 'style-1'], ['TWO', 'Flame Style 2', 'style-2'], ['THREE', 'Flame Style 3', 'style-3']],
        startIndex: index,
      }));
    }

    const primary = this.groups[0].switches[0].svc;
    primary.setPrimaryService(true);
    for (const g of this.groups) {
      for (const { svc } of g.switches) {
        if (svc !== primary) {
          primary.addLinkedService(svc);
        }
      }
    }
    this.pruneServices();
  }

  /**
   * A set of Switch services that act like radio buttons for one enum data point.
   * With offValue, turning the selected switch off writes offValue; without it, one stays selected.
   */
  radioGroup({ dp, label, options, offValue, startIndex }) {
    const { Service, Characteristic: C } = this.hap;
    const group = { dp, offValue, switches: [] };
    options.forEach(([value, name, subtype], i) => {
      const svc = this.service(Service.Switch, name, subtype);
      this.labelIndex(svc, startIndex + i);
      svc.getCharacteristic(C.On)
        .onGet(this.getter(() => this.device.powerOn && this.device.value(dp) === value))
        .onSet(this.setter(async (v) => {
          const selected = this.device.value(dp) === value;
          if (v) {
            if (!selected || !this.device.powerOn) {
              await this.cosmetic({ [dp]: value }, { turnsSomethingOn: true, label: `${label}: ${name}` });
            }
          } else if (selected && offValue && this.device.powerOn) {
            await this.cosmetic({ [dp]: offValue }, { label: `${label}: off` });
          }
          // Re-push the whole group so the other switches flip (or this one reverts).
          this.refreshSoon(150);
        }));
      group.switches.push({ svc, value });
    });
    return group;
  }

  refresh() {
    if (!this.device.reachable) {
      return;
    }
    const C = this.hap.Characteristic;
    for (const g of this.groups) {
      const cur = this.device.value(g.dp);
      for (const { svc, value } of g.switches) {
        svc.updateCharacteristic(C.On, this.device.powerOn && cur === value);
      }
    }
  }
}

module.exports = {
  Batch,
  PowerAccessory,
  HeatAccessory,
  LightsAccessory,
  EffectsAccessory,
};
