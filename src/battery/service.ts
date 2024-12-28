import {Service} from 'homebridge';
import ReadThroughCache from '../readThroughCache.js';
import {SleepmePlatformAccessory} from '../platformAccessory';

export function createBatteryService(platformAccessory: SleepmePlatformAccessory, readThroughCache: ReadThroughCache): Service {
  const {platform, accessory} = platformAccessory;
  const {StatusLowBattery, BatteryLevel} = platform.Characteristic;
  const batteryService = accessory.getService(platform.Service.Battery) ||
    accessory.addService(platform.Service.Battery, `${accessory.displayName} - Dock Pro Water Level`);

  batteryService.getCharacteristic(StatusLowBattery)
    .onGet(() =>
      readThroughCache.get().then(r => r.data)
        .then(status => status.status.is_water_low));

  batteryService.getCharacteristic(BatteryLevel)
    .onGet(() =>
      readThroughCache.get().then(r => r.data)
        .then(status => status.status.water_level))

  return batteryService;
}
