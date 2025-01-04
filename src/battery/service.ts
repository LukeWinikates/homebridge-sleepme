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
      readThroughCache.get()
        .then(r => {
          return r ? r.data.status.is_water_low : null;
        }));

  batteryService.getCharacteristic(BatteryLevel)
    .onGet(() =>
      readThroughCache.get().then(r => {
        return r ? r.data.status.water_level : null;
      }));

  return batteryService;
}
