import {CharacteristicValue} from 'homebridge';
import {Client} from '../sleepme/client';
import {SleepmePlatformAccessory} from '../platformAccessory.js';

interface Setters {
  setTargetState(value: CharacteristicValue): Promise<void>

  setTargetTemp(value: CharacteristicValue): Promise<void>
}

export function newSetters(sleepmePlatformAccessory: SleepmePlatformAccessory, client: Client, id: string): Setters {
  const {platform, accessory } = sleepmePlatformAccessory;
  return {
    setTargetState: (value: CharacteristicValue) => {
      const targetState = (value === 0) ? 'standby' : 'active';
      platform.log(`setting TargetHeatingCoolingState for ${id} to ${targetState} (${value})`);
      return client.setThermalControlStatus(id, targetState).then(r => {
        platform.log(`response (${accessory.displayName}): ${r.status}`);
      });
    },
    setTargetTemp: (value: CharacteristicValue) => {
      const tempF = Math.floor((value as number * (9 / 5)) + 32);
      platform.log(`setting TargetTemperature for ${accessory.displayName} to ${tempF} (${value})`);
      return client.setTemperatureFahrenheit(id, tempF)
        .then(r => {
          platform.log(`response (${accessory.displayName}): ${r.status}`);
        });
    },
  };
}
