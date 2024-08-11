import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepMePlatform} from './platform.js';
import {Client, Control, Device, DeviceStatus} from './sleepme/client.js';

type SleepMeContext = {
  device: Device;
  apiKey: string;
};

interface Mapper {
  toHeatingCoolingState: (status: DeviceStatus) => 0 | 2;
}

function newMapper(platform: SleepMePlatform): Mapper {
  const {Characteristic} = platform;
  return {
    toHeatingCoolingState: (status: DeviceStatus): 0 | 2 => {
      return status.control.thermal_control_status === 'standby' ?
        Characteristic.CurrentHeatingCoolingState.OFF :
        Characteristic.CurrentHeatingCoolingState.COOL;
    },
  };
}

class Option<T> {
  readonly value: T | null;

  constructor(value: T | null) {
    this.value = value;
  }

  map<TNext>(mapF: (value: T) => TNext): Option<TNext> {
    if (this.value) {
      return new Option(mapF(this.value));
    }
    return new Option<TNext>(null);
  }

  orElse<T>(elseValue: T): T {
    if (!this.value) {
      return elseValue;
    }
    return this.value as T;
  }
}

const FAST_POLLING_INTERVAL_MS = 15 * 1000;
const SLOW_POLLING_INTERVAL_MS = 15 * 60 * 1000;
const POLLING_RECENCY_THRESHOLD_MS = 5 * 1000;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different thermostatService types.
 */
export class SleepMePlatformAccessory {
  private thermostatService: Service;
  private batteryService: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.lastInteractionTime = new Date();
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepMeContext;
    const client = new Client(apiKey);
    this.deviceStatus = null;
    const mapper = newMapper(platform);
    this.scheduleNextCheck = this.scheduleNextCheck.bind(this);
    this.updateControlFromResponse = this.updateControlFromResponse.bind(this);
    this.publishUpdates = this.publishUpdates.bind(this);

    // set accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'SleepMe')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    client.getDeviceStatus(device.id)
      .then(statusResponse => {
        this.deviceStatus = statusResponse.data;
      });

    this.thermostatService = this.accessory.getService(Service.Thermostat) ||
      this.accessory.addService(Service.Thermostat, `${this.accessory.displayName} - Dock Pro`);
    this.batteryService = this.accessory.getService(Service.Battery) ||
      this.accessory.addService(Service.Battery, `${this.accessory.displayName} - Dock Pro Water Level`);

    // create handlers for required characteristics
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => mapper.toHeatingCoolingState(ds))
        .orElse(0));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => mapper.toHeatingCoolingState(ds))
        .orElse(0))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === 0) ? 'standby' : 'active';
        return client.setThermalControlStatus(device.id, targetState)
          .then(r => this.updateControlFromResponse(r));
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() =>
        new Option(this.deviceStatus)
          .map(ds => ds.status.water_temperature_c)
          .orElse(-270));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.set_temperature_c)
        .orElse(10))
      .onSet(async (value: CharacteristicValue) => {
        const tempF = Math.floor((value as number * (9/5)) + 32);
        return client.setTemperatureFahrenheit(device.id, tempF)
          .then(r => this.updateControlFromResponse(r));
      });

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));

    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.status.is_water_low)
        .orElse(false));

    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.status.water_level)
        .orElse(50));

    this.scheduleNextCheck(() => client.getDeviceStatus(device.id)
      .then(res => res.data));
  }

  private scheduleNextCheck(poller: () => Promise<DeviceStatus>) {
    const timeSinceLastInteractionMS = new Date().valueOf() - this.lastInteractionTime.valueOf();
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.platform.log('polling at: ' + new Date());
      poller().then(s => {
        this.deviceStatus = s;
        this.publishUpdates();
      }).then(() => {
        this.scheduleNextCheck(poller);
      });
    }, timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS ? FAST_POLLING_INTERVAL_MS : SLOW_POLLING_INTERVAL_MS);
  }

  private updateControlFromResponse(response: { data: Control }) {
    this.deviceStatus && (this.deviceStatus.control = response.data);
    this.lastInteractionTime = new Date();
    this.publishUpdates();
  }

  private publishUpdates() {
    const s = this.deviceStatus;
    if (!s) {
      return;
    }
    const {Characteristic} = this.platform;
    const mapper = newMapper(this.platform);
    this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, s.status.water_level);
    this.batteryService.updateCharacteristic(Characteristic.StatusLowBattery, s.status.is_water_low);
    this.thermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, s.control.display_temperature_unit === 'c' ? 0 : 1);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, mapper.toHeatingCoolingState(s));
    this.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, mapper.toHeatingCoolingState(s));
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, s.status.water_temperature_c);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, s.control.set_temperature_c);
  }
}
