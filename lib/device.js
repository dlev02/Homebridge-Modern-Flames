'use strict';

const { EventEmitter } = require('node:events');
const TuyAPI = require('tuyapi');
const { DP, assertWritable } = require('./mapping');

const BACKOFF_SECONDS = [2, 4, 8, 15, 30, 60];
const CONNECT_TIMEOUT_MS = 12000;
const WRITE_TIMEOUT_MS = 6000;
const POLL_MS = 60000;
const FLUSH_DELAY_MS = 1500;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Persistent local (LAN) connection to the fireplace.
 *
 * Events:
 *  - 'update' (changedDps: string[])  state changed (from HomeKit, the remote or Smart Life)
 *  - 'reachable' / 'unreachable'
 *
 * The local key is passed straight to tuyapi and is never logged.
 */
class FireplaceDevice extends EventEmitter {
  constructor({ id, ip, key, version }, log) {
    super();
    this.log = log;
    this.id = id;
    this.ip = ip;
    this.state = {};
    /** Cosmetic writes held while the fireplace is off, sent when it turns on. */
    this.pending = {};
    this._connected = false;
    this._stopped = true;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._flushTimer = null;
    this._writeChain = Promise.resolve();
    this._queuedWrite = null;
    this._loggedUnreachable = false;

    this.tuya = new TuyAPI({
      id,
      key,
      ip,
      version: String(version || '3.3'),
      issueGetOnConnect: true,
      issueRefreshOnConnect: false,
      issueRefreshOnPing: false,
    });

    this.tuya.on('connected', () => this._onConnected());
    this.tuya.on('disconnected', () => this._onDisconnected());
    this.tuya.on('error', (err) => this._onError(err));
    this.tuya.on('data', (data) => this._onData(data));
    this.tuya.on('dp-refresh', (data) => this._onData(data));
  }

  /** Connected and holding a real state snapshot. */
  get reachable() {
    return this._connected && this.state[DP.POWER] !== undefined;
  }

  get powerOn() {
    return this.state[DP.POWER] === true;
  }

  /** Current value, with any queued cosmetic change overlaid. */
  value(dp) {
    return Object.prototype.hasOwnProperty.call(this.pending, dp) ? this.pending[dp] : this.state[dp];
  }

  start() {
    this._stopped = false;
    this._connect();
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._flushTimer);
    clearInterval(this._pollTimer);
    try {
      this.tuya.disconnect();
    } catch {
      // ignore
    }
  }

  async _connect() {
    if (this._stopped || this._connected) {
      return;
    }
    try {
      await withTimeout(this.tuya.connect(), CONNECT_TIMEOUT_MS, 'Connect');
    } catch (err) {
      this._dropSocket();
      this._noteFailure(err);
      this._scheduleReconnect();
    }
  }

  _dropSocket() {
    try {
      if (this.tuya.client) {
        this.tuya.client.destroy();
      }
      this.tuya.disconnect();
    } catch {
      // ignore
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) {
      return;
    }
    const delay = BACKOFF_SECONDS[Math.min(this._attempt, BACKOFF_SECONDS.length - 1)];
    this._attempt += 1;
    this.log.debug(`Reconnecting to the fireplace in ${delay}s`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay * 1000);
  }

  _noteFailure(err) {
    const msg = err && err.message ? err.message : String(err);
    if (!this._loggedUnreachable) {
      this.log.warn(`Fireplace at ${this.ip} is not reachable (${msg}). HomeKit will show No Response until it is back; retrying.`);
      this._loggedUnreachable = true;
    } else {
      this.log.debug(`Fireplace still unreachable: ${msg}`);
    }
  }

  _onConnected() {
    this._connected = true;
    this._attempt = 0;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this._loggedUnreachable) {
      this.log.info('Fireplace is reachable again.');
    } else {
      this.log.info(`Connected to the fireplace at ${this.ip}.`);
    }
    this._loggedUnreachable = false;
    // issueGetOnConnect asks for a full status; reachable/update fire when it arrives.
  }

  _onDisconnected() {
    const wasReachable = this.reachable;
    this._connected = false;
    if (wasReachable) {
      this.emit('unreachable');
    }
    if (!this._stopped) {
      this._noteFailure(new Error('connection closed'));
      this._scheduleReconnect();
    }
  }

  _onError(err) {
    const msg = err && err.message ? err.message : String(err);
    this.log.debug(`Fireplace connection error: ${msg}`);
    if (!this._connected) {
      this._scheduleReconnect();
    }
  }

  _onData(data) {
    if (!data || typeof data !== 'object' || !data.dps || typeof data.dps !== 'object') {
      return;
    }
    const wasReachable = this.reachable;
    const wasOn = this.powerOn;
    const changed = [];
    for (const [k, v] of Object.entries(data.dps)) {
      if (this.state[k] !== v) {
        this.state[k] = v;
        changed.push(k);
      }
      // A confirmed value supersedes a queued one only if they match.
      if (Object.prototype.hasOwnProperty.call(this.pending, k) && this.pending[k] === v) {
        delete this.pending[k];
      }
    }
    if (!wasReachable && this.reachable) {
      this.emit('reachable');
    }
    if (changed.length) {
      this.log.debug(`State changed: ${changed.map((k) => `${k}=${JSON.stringify(this.state[k])}`).join(', ')}`);
      this.emit('update', changed);
    }
    if (!wasOn && this.powerOn && Object.keys(this.pending).length) {
      clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this._flushPending(), FLUSH_DELAY_MS);
    }
  }

  async _poll() {
    if (!this._connected) {
      return;
    }
    try {
      const data = await withTimeout(this.tuya.get({ schema: true }), WRITE_TIMEOUT_MS, 'Status poll');
      this._onData(data);
    } catch (err) {
      this.log.debug(`Status poll failed: ${err.message}`);
    }
  }

  /** Hold cosmetic values until the fireplace turns on. */
  queue(dps) {
    assertWritable(dps);
    Object.assign(this.pending, dps);
    this.emit('update', Object.keys(dps));
  }

  async _flushPending() {
    if (!this.powerOn || !Object.keys(this.pending).length) {
      return;
    }
    const dps = { ...this.pending };
    this.log.info(`Fireplace turned on: applying ${Object.keys(dps).length} queued setting(s).`);
    try {
      await this.set(dps);
      for (const k of Object.keys(dps)) {
        if (this.pending[k] === dps[k]) {
          delete this.pending[k];
        }
      }
    } catch (err) {
      this.log.warn(`Could not apply queued settings: ${err.message}`);
    }
  }

  /**
   * Write data points. Only allow-listed DPs can be written. Writes are serialized.
   * Throws if the fireplace is unreachable.
   */
  set(dps) {
    assertWritable(dps);
    // A write still waiting its turn absorbs newer values (latest wins), so dragging a slider
    // sends a few writes instead of queueing dozens behind a slow device.
    if (this._queuedWrite) {
      Object.assign(this._queuedWrite.data, dps);
      return this._queuedWrite.promise;
    }
    const entry = { data: { ...dps } };
    const run = () => {
      if (this._queuedWrite === entry) {
        this._queuedWrite = null;
      }
      return this._write(entry.data);
    };
    entry.promise = this._writeChain.then(run, run);
    this._queuedWrite = entry;
    this._writeChain = entry.promise.catch(() => undefined);
    return entry.promise;
  }

  async _write(dps) {
    if (!this._connected) {
      throw new Error('Fireplace is not reachable');
    }
    const data = {};
    for (const [k, v] of Object.entries(dps)) {
      data[String(k)] = v;
    }
    this.log.debug(`Write: ${Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    let res;
    try {
      res = await withTimeout(
        this.tuya.set({ multiple: true, data, shouldWaitForResponse: true }),
        WRITE_TIMEOUT_MS,
        'Command',
      );
    } catch (err) {
      // The fireplace sometimes applies a command without replying. Re-read before calling it a failure.
      await this._poll();
      if (Object.entries(data).every(([k, v]) => this.state[k] === v)) {
        this.log.debug(`Write confirmed by status read after: ${err.message}`);
        return undefined;
      }
      throw err;
    }
    if (res && typeof res === 'object' && res.dps) {
      this._onData(res);
    } else {
      setTimeout(() => this._poll(), 500);
    }
    return res;
  }

  /** Resolve when a data point reports the expected value, or reject after timeoutMs. */
  waitFor(dp, expected, timeoutMs) {
    if (this.state[dp] === expected) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onUpdate = () => {
        if (this.state[dp] === expected) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`No confirmation for data point ${dp}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('update', onUpdate);
      };
      this.on('update', onUpdate);
      this._poll();
    });
  }
}

module.exports = { FireplaceDevice };
