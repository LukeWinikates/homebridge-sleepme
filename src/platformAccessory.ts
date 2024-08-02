import {Service, PlatformAccessory, CharacteristicValue} from 'homebridge';

import {SleepMePlatform} from './platform.js';
import {Client, Device, DeviceStatus} from './sleepme/client.js';

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

function setTargetTemperature(client: Client, device: Device) {
  return async (value: CharacteristicValue) => {
    return client.setTemperatureCelsius(device.id, value as number).then(() => {
    });
  };
}

function setTargetHeatingCoolingState(client: Client, device: Device) {
  return async (value: CharacteristicValue) => {
    const targetState = (value === 0) ? 'standby' : 'active';
    return client.setThermalControlStatus(device.id, targetState).then(() => {
    });
  };
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class SleepMePlatformAccessory {
  private service: Service;
  private deviceStatus: DeviceStatus | null;

  constructor(
    private readonly platform: SleepMePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepMeContext;
    const client = new Client(apiKey);
    this.deviceStatus = null;
    const mapper = newMapper(platform);

    // set accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'SleepMe')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    client.getDeviceStatus(device.id)
      .then(statusResponse => {
        this.deviceStatus = statusResponse.data;
      });

    const accessoryService = Service.Thermostat;
    this.service = this.accessory.getService(accessoryService) || this.accessory.addService(accessoryService);

    // create handlers for required characteristics
    this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => mapper.toHeatingCoolingState(ds))
        .orElse(0));

    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => mapper.toHeatingCoolingState(ds))
        .orElse(0))
      .onSet(setTargetHeatingCoolingState(client, device));

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() =>
        new Option(this.deviceStatus)
          .map(ds => ds.status.water_temperature_c)
          .orElse(-270));

    this.service.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.set_temperature_c)
        .orElse(10))
      .onSet(setTargetTemperature(client, device));

    this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));

    this.service.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.status.is_water_low)
        .orElse(false));
    //
    // // each service must implement at-minimum the "required characteristics" for the given service type
    // // see https://developers.homebridge.io/#/service/Lightbulb
    //
    // // register handlers for the On/Off Characteristic
    // this.service.getCharacteristic(this.platform.Characteristic.On)
    //   .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
    //   .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below
    //
    // // register handlers for the Brightness Characteristic
    // this.service.getCharacteristic(this.platform.Characteristic.Brightness)
    //   .onSet(this.setBrightness.bind(this));       // SET - bind to the 'setBrightness` method below

    /**
     * Creating multiple services of the same type.
     *
     * To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
     * when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
     * this.accessory.getService('NAME') || this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE_ID');
     *
     * The USER_DEFINED_SUBTYPE must be unique to the platform accessory (if you platform exposes multiple accessories, each accessory
     * can use the same subtype id.)
     */

    // /**
    //  * Updating characteristics values asynchronously.
    //  *
    //  * Example showing how to update the state of a Characteristic asynchronously instead
    //  * of using the `on('get')` handlers.
    //  * Here we change update the motion sensor trigger states on and off every 10 seconds
    //  * the `updateCharacteristic` method.
    //  *
    //  */
    // let motionDetected = false;
    // setInterval(() => {
    //   // EXAMPLE - inverse the trigger
    //   motionDetected = !motionDetected;
    //
    //   // push the new value to HomeKit
    //   motionSensorOneService.updateCharacteristic(this.platform.Characteristic.MotionDetected, motionDetected);
    //   motionSensorTwoService.updateCharacteristic(this.platform.Characteristic.MotionDetected, !motionDetected);
    //
    //   this.platform.log.debug('Triggering motionSensorOneService:', motionDetected);
    //   this.platform.log.debug('Triggering motionSensorTwoService:', !motionDetected);
    // }, 10000);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   //  */
  // async setOn(value: CharacteristicValue) {
  //   // implement your own code to turn your device on/off
  //   this.exampleStates.On = value as boolean;
  //
  //   this.platform.log.debug('Set Characteristic On ->', value);
  // }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  // async getOn(): Promise<CharacteristicValue> {
  //   // implement your own code to check if the device is on
  //   const isOn = this.exampleStates.On;
  //
  //   this.platform.log.debug('Get Characteristic On ->', isOn);
  //
  //   // if you need to return an error to show the device as "Not Responding" in the Home app:
  //   // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  //
  //   return isOn;
  // }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  // async setTargetTemperature(value: CharacteristicValue) {
  //   // implement your own code to set the brightness
  //    = value as number;
  //    return new Client(this.ap.
  //   this.platform.log.debug('Set Characteristic Brightness -> ', value);
  // }

}
