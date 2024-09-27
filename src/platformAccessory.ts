import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, Control, Device, DeviceStatus} from './sleepme/client.js';

type SleepmeContext = {
  device: Device;
  apiKey: string;
};

interface Mapper {
  toHeatingCoolingState: (status: DeviceStatus) => 0 | 2;
}

function newMapper(platform: SleepmePlatform): Mapper {
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
export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private batteryService: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.lastInteractionTime = new Date();
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    const client = new Client(apiKey);
    this.deviceStatus = null;
    const mapper = newMapper(platform);
    this.scheduleNextCheck = this.scheduleNextCheck.bind(this);
    this.updateControlFromResponse = this.updateControlFromResponse.bind(this);
    this.publishUpdates = this.publishUpdates.bind(this);

    // set accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepme')
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
        this.platform.log(`setting TargetHeatingCoolingState for ${this.accessory.displayName} to ${targetState} (${value})`)
        return client.setThermalControlStatus(device.id, targetState)
          .then(r => {
            this.platform.log(`response (${this.accessory.displayName}): ${r.status}`)
            this.updateControlFromResponse(r);
          });
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
        const tempF = Math.floor((value as number * (9 / 5)) + 32);
        this.platform.log(`setting TargetTemperature for ${this.accessory.displayName} to ${tempF} (${value})`)
        return client.setTemperatureFahrenheit(device.id, tempF)
          .then(r => {
            this.platform.log(`response (${this.accessory.displayName}): ${r.status}`)
            this.updateControlFromResponse(r);
          });
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

    this.scheduleNextCheck(async () => {
      this.platform.log(`polling device status for ${this.accessory.displayName}`)
      const r = await client.getDeviceStatus(device.id);
      this.platform.log(`response (${this.accessory.displayName}): ${r.status}`)
      return r.data
    });
  }

  private scheduleNextCheck(poller: () => Promise<DeviceStatus>) {
    const timeSinceLastInteractionMS = new Date().valueOf() - this.lastInteractionTime.valueOf();
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.platform.log(`polling at: ${new Date()}`);
      this.platform.log(`last interaction at: ${this.lastInteractionTime}`);
      poller().then(s => {
        this.deviceStatus = s;
        this.publishUpdates();
      }).then(() => {
        this.scheduleNextCheck(poller);
      });
    }, timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS ? FAST_POLLING_INTERVAL_MS : SLOW_POLLING_INTERVAL_MS);
  }

  private updateControlFromResponse(response: { data: Control }) {
    if (this.deviceStatus) {
      this.deviceStatus.control = response.data;
    }
    this.lastInteractionTime = new Date();
    this.publishUpdates();
  }

  private publishUpdates() {
    const s = this.deviceStatus;
    if (!s) {
      return;
    }
    this.platform.log(`${this.accessory.displayName}: ${JSON.stringify({
      status: s.status,
      control: s.control,
    }, null, 2)}`)
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
