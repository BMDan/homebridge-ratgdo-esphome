import EventSource from 'eventsource';
import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import fetch from 'node-fetch'; // I am, in fact, trying to make fetch happen.
import { RECONNECT_TIMEOUT } from './settings';
import Timeout = NodeJS.Timeout;

import { RatgdoEsphomePlatform } from './platform';

interface ESPHomeBaseEvent {
  id: string;
  //state: string // guaranteed per the docs, but we don't need it
}

interface ESPHomeCoverDoorEvent {
  id: string;
  state: 'CLOSED' | 'OPEN';
  value: number;
  current_operation: 'IDLE' | 'OPENING' | 'CLOSING';
  position: number;
}

interface ESPHomeBinarySensorEvent {
  id: string;
  name: string;
  //icon: string;
  //entity_category: int;
  value: boolean;
  state: 'OFF' | 'ON';
}

interface ESPHomeButtonEvent {
  id: string;
  name: string;
  //icon: string;
  //entity_category: int;
}

interface ESPHomeTextSensorEvent {
  id: string;
  name: string;
  //icon: string;
  //entity_category: int;
  value: string;
  state: string;
}

interface ESPHomeLockEvent {
  id: string;
  name: string;
  //icon: string;
  //entity_category: int;
  value: number;
  state: string;
}

const BINARY_SENSOR_PREFIX = 'binary_sensor-';
const BUTTON_PREFIX = 'button-';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class RatgdoEsphomeAccessory {
  private service: Service;
  private host: string;
  private port: number;
  private eventSource: EventSource;
  private initialized: boolean; // only T/F; unlike discovery.ts, we don't ever stop
  private aliveTimeout: Timeout | null;
  private lastLogReceived: string | null = null;

  // "published" variables:
  private State: 'CLOSED' | 'OPEN' | null = null;
  private Position: number | null = null; // fraction open/closed; might not always be accurate
  private CurrentOperation: 'IDLE' | 'OPENING' | 'CLOSING' | null = null;
  private ObstructionDetected: boolean | null = null;
  private FirmwareRevision: string | null = null;
  private LockCurrentState: 'UNSECURED' | 'SECURED' | 'JAMMED' | 'UNKNOWN' | null = null;

  constructor(
    private readonly platform: RatgdoEsphomePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly Model: string,
    private readonly SerialNumber: string,
  ) {
    this.initialized = false;
    this.host = accessory.context.device.host;
    this.port = accessory.context.device.port;
    this.aliveTimeout = null as unknown as Timeout;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'RatGDO (ESPHome)')
      .setCharacteristic(this.platform.Characteristic.Model, this.Model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.SerialNumber);

    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
                  || this.accessory.addService(this.platform.Service.GarageDoorOpener);

    // Set the service name.  This is what is displayed as the name on the Home
    // app.  We use what we stored in `accessory.context` in  `discoverDevices`.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleCurrentDoorStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleTargetDoorStateGet.bind(this))
      .onSet(this.handleTargetDoorStateSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.handleObstructionDetectedGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.handleLockCurrentStateGet.bind(this));

    // Publish firmware version; this may not be initialized yet, so we set a getter.
    // Note that this is against the AccessoryInformation service, not the GDO service.
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .getCharacteristic(this.platform.Characteristic.FirmwareRevision)
      .onGet(this.handleFirmwareRevisionGet.bind(this));

    this.initConnection();
  }

  async handleFirmwareRevisionGet(): Promise<CharacteristicValue> {
    if ( this.FirmwareRevision !== null ) {
      return this.FirmwareRevision;
    }
    return '';
  }

  async handleLockCurrentStateGet(): Promise<CharacteristicValue> {
    return this.handleLockCurrentStateGet2();
  }

  private handleLockCurrentStateGet2(): CharacteristicValue {
    if (this.LockCurrentState === 'SECURED') {
      return this.platform.Characteristic.LockCurrentState.SECURED;
    }
    if (this.LockCurrentState === 'UNSECURED') {
      return this.platform.Characteristic.LockCurrentState.UNSECURED;
    }
    this.warn('Unrecognized LockCurrentState; returning unknown for ', this.LockCurrentState);
    return this.platform.Characteristic.LockCurrentState.UNKNOWN;
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    this.debug('Returning current state of door for:', this.State, this.CurrentOperation);
    if (this.CurrentOperation === 'CLOSING') {
      return this.platform.Characteristic.CurrentDoorState.CLOSING;
    } else if (this.CurrentOperation === 'OPENING') {
      return this.platform.Characteristic.CurrentDoorState.OPENING;
    } else {
      return this.State === 'CLOSED'
        ? this.platform.Characteristic.CurrentDoorState.CLOSED
        : this.platform.Characteristic.CurrentDoorState.OPEN;
    }
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    return this._handleTargetDoorStateGet();
  }

  private _handleTargetDoorStateGet(): CharacteristicValue {
    if ( this.CurrentOperation === 'OPENING' ) {
      this.info('Returning target state of moving door as OPEN.');
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if ( this.CurrentOperation === 'CLOSING' ) {
      this.info('Returning target state of moving door as CLOSED.');
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }
    if ( this.CurrentOperation === 'IDLE' ) {
      this.debug('Target state inquiry against Idle door; returning current state:', this.State);
      return this.State === 'CLOSED'
        ? this.platform.Characteristic.TargetDoorState.CLOSED
        : this.platform.Characteristic.TargetDoorState.OPEN;
    }
    throw new Error(`Unknown CurrentOperation: ${this.CurrentOperation}`);
  }

  async handleTargetDoorStateSet(value: CharacteristicValue) {
    let target: string;
    if (value === this.platform.Characteristic.TargetDoorState.CLOSED) {
      target = 'close';
    } else if (value === this.platform.Characteristic.TargetDoorState.OPEN) {
      target = 'open';
    } else {
      throw new Error(`Wack targetdoorstate requested: ${value}`);
    }
    this.info('Set target door state to:', target);
    await fetch(`http://${this.host}:${this.port}/cover/door/${target}`, {method: 'POST'});
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    if ( this.ObstructionDetected === null ) {
      this.warn('No obstruction status has been received yet; foolishly pretending door is not obstructed.');
      return false;
    }
    return this.ObstructionDetected;
  }

  private async initConnection(): Promise<EventSource> {
    try {
      this.eventSource = await this.connectToESPSource();
    } catch (e) {
      this.error('Failed to connect to ESPHome Source:', e);
      this.eventSource = null;
      setTimeout(() => {
        this.initConnection();
      }, RECONNECT_TIMEOUT);
      return null;
    }
  }

  private createTimeout(): Timeout | null {
    return setTimeout(async () => {
      this.info('Timeout is closing connection...');
      this.closeConnection();
      this.info('Timeout has closed connection; reopening...');
      await this.initConnection();
      this.debug('Timeout has reopened connection.');
    }, 20 * 1000); // if no ping is received in 20 seconds, we reconnect
  }

  private closeConnection() {
    this.closeConnection2(this.eventSource);
  }

  // The ping event happens so quickly that the `await` that will populate
  // this.eventsource often hasn't finished yet, so we cheat and just pass
  // it in directly from the ping handler.  The timeout handler, on the
  // other hand, is well-behaved, so it sources from `this.`.
  private closeConnection2(eventSource: EventSource) {
    this.debug('Closing connection...');
    try {
      if (!eventSource) {
        this.debug('No event source to close.');
      } else {
        eventSource.close();
        this.debug('Connection closed.');
      }
    } catch (e) {
      this.warn('Unable to cleanly close init listener:', e);
    } finally {
      if (this.initialized) { // Don't overwrite null.
        this.initialized = false;
      }
    }
    this.debug('Close attempt completed.');
  }

  private connectToESPSource(): Promise<EventSource> {
    return new Promise((resolve, reject) => {
      try {
        const url = `http://${this.host}:${this.port}/events`;
        const eventSource = new EventSource(url);

        eventSource.onerror = async (e) => {
          this.warn('Connection error, reinitializing...', e, this.lastLogReceived);
          this.initialized = false;
          reject(e);
        };
        eventSource.onopen = () => {
          if (!this.initialized) {
            this.info(`Connection to ESP initialized. Event source started at ${url}.`);
            this.initialized = true;
            if ( this.aliveTimeout !== null ) {
              clearTimeout(this.aliveTimeout);
            }
            this.aliveTimeout = this.createTimeout();
            eventSource.addEventListener('state', ev => {
              try {
                const a = JSON.parse(ev.data) as ESPHomeBaseEvent;
                if (a.id === 'cover-door') {
                  const b = JSON.parse(ev.data) as ESPHomeCoverDoorEvent;
                  this.State = b.state;
                  this.CurrentOperation = b.current_operation;
                  this.Position = b.position;
                  this.service.updateCharacteristic(
                    this.platform.Characteristic.CurrentDoorState,
                    this.State === 'CLOSED'
                      ? this.platform.Characteristic.CurrentDoorState.CLOSED
                      : this.platform.Characteristic.CurrentDoorState.OPEN,
                  );
                  this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this._handleTargetDoorStateGet());
                } else if (a.id.startsWith(BINARY_SENSOR_PREFIX)) {
                  const b = JSON.parse(ev.data) as ESPHomeBinarySensorEvent;
                  const short_id = b.id.slice(BINARY_SENSOR_PREFIX.length);
                  if (short_id === 'obstruction') {
                    this.ObstructionDetected = b.value;
                    this.service.updateCharacteristic(
                      this.platform.Characteristic.ObstructionDetected,
                      b.value,
                    );
                  } else if (short_id.startsWith('dry_contact_')) {
                    this.info(`Sensor "${b.name}" [${short_id}] reports ${b.state} [${b.value}].`);
                  } else {
                    this.info(`Sensor "${b.name}" [${short_id}] reports ${b.state} [${b.value}].`);
                  }
                } else if (a.id.startsWith(BUTTON_PREFIX)) {
                  const b = JSON.parse(ev.data) as ESPHomeButtonEvent;
                  const short_id = b.id.slice(BUTTON_PREFIX.length);
                  this.info(`Button "${b.name}" [${short_id}] reports that it exists.`);
                } else if (a.id === 'text_sensor-firmware_version') {
                  const b = JSON.parse(ev.data) as ESPHomeTextSensorEvent;
                  if (b.value === b.state && b.value !== '' && b.value !== null) {
                    this.info('Firmware version:', b.value);
                    this.FirmwareRevision = b.value;
                    // TODO: Actively push updated firmware value via `updateChar...()`
                  } else {
                    this.error('Mismatched firmware versions in value/state:', b.value, b.state);
                    this.FirmwareRevision = null;
                  }
                } else if (a.id === 'lock-lock_remotes') {
                  const b = JSON.parse(ev.data) as ESPHomeLockEvent;
                  if ( b.state === 'LOCKED' ) {
                    this.LockCurrentState = 'SECURED';
                    this.info('Remote lock is in LOCKED state.');
                  } else if ( b.state === 'UNLOCKED' ) {
                    this.LockCurrentState = 'UNSECURED';
                    this.info('Remote lock is UNLOCKED (this is normal).');
                  } else {
                    this.warn('Unsupported remote-lock state:', b.value, b.state);
                    this.LockCurrentState = 'UNKNOWN';
                  }
                  this.service.updateCharacteristic(
                    this.platform.Characteristic.LockCurrentState,
                    this.handleLockCurrentStateGet2(),
                  );
                } else {
                  this.info('Discarding uninteresting state event:', a.id);
                  this.debug('Full message:', a);
                  return;
                }
              } catch(e) {
                this.error('Cannot deserialize message:', ev);
                this.error('Deserialization yielded:', e);
              }
            });
            eventSource.addEventListener('log', ev => {
              this.lastLogReceived = ev.data;
              this.debug('esphome log:', ev.data);
              if (this.State === null) {
                try {
                  // Log format is: \e[0;36m[D][filename:lineno]: logmessage\e[0m
                  const bareLog = ev.data.split(': ')[1];
                  if (bareLog.startsWith('Door state=OPEN')) {
                    this.State = 'OPEN';
                  } else if (bareLog.startsWith('Door state=CLOSED')) {
                    this.State = 'CLOSED';
                  }
                } catch(e) {
                  this.error('Log parsing error:', e);
                }
              }

            });
            eventSource.addEventListener('ping', () => {
              if ( this.aliveTimeout !== null ) {
                clearTimeout(this.aliveTimeout);
              }
              this.aliveTimeout = this.createTimeout();
            });
            resolve(eventSource);
          }
        };
      } catch (e) {
        this.error('Unhandled error in Connect:', e);
        reject(e);
      }
    });
  }

  private debug(message: string, ...parameters: unknown[]): void {
    this.platform.log.debug(`[${this.SerialNumber}] ${message}`, ...parameters);
  }

  private info(message: string, ...parameters: unknown[]): void {
    this.platform.log.info(`[${this.SerialNumber}] ${message}`, ...parameters);
  }

  private warn(message: string, ...parameters: unknown[]): void {
    this.platform.log.warn(`[${this.SerialNumber}] ${message}`, ...parameters);
  }

  private error(message: string, ...parameters: unknown[]): void {
    this.platform.log.error(`[${this.SerialNumber}] ${message}`, ...parameters);
  }

}
