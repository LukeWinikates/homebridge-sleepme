import {Service} from 'homebridge';
import {SleepmePlatformAccessory} from '../platformAccessory.js';
import ReadThroughCache from '../readThroughCache.js';
import {NewMapper} from './thermostatMapper.js';
import {newSetters} from './setters.js';

export function createThermostatService(
  platformAccessory: SleepmePlatformAccessory,
  readThroughCache: ReadThroughCache,
  deviceId: string): Service {
  const {platform, accessory} = platformAccessory;
  const {Characteristic} = platform;
  const thermostatMapper = NewMapper(platform);
  const thermostatService = accessory.getService(platform.Service.Thermostat) ||
    accessory.addService(platform.Service.Thermostat, `${accessory.displayName} - Dock Pro`);
  const setters = newSetters(platformAccessory, readThroughCache.client, deviceId)

  thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .onGet(() => readThroughCache.get()
      .then(response => thermostatMapper.toCurrentHeatingCoolingState(response.data)));

  const {AUTO, OFF} = Characteristic.TargetHeatingCoolingState
  thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({validValues: [OFF, AUTO]})
    .onGet(() => readThroughCache.get()
      .then(response => thermostatMapper.toTargetHeatingCoolingState(response.data)))
    .onSet(setters.setTargetState);

  thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(() => readThroughCache.get()
      .then(response => response.data.status.water_temperature_c))

  thermostatService.getCharacteristic(Characteristic.TargetTemperature)
    .onGet(() => readThroughCache.get()
      .then(response => response.data.control.set_temperature_c))
    .onSet(setters.setTargetTemp);

  thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .onGet(() => readThroughCache.get()
      .then(response => thermostatMapper.toTemperatureDisplayUnits(response.data)));

  return thermostatService;
}
