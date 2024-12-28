import {DeviceStatus} from '../sleepme/client';
import {SleepmePlatform} from '../platform';

interface Mapper {
  toCurrentHeatingCoolingState: (status: DeviceStatus) => 0 | 1 | 2;
  toTargetHeatingCoolingState: (status: DeviceStatus) => 0 | 3;
  toTemperatureDisplayUnits: (status: DeviceStatus) => 0 | 1
}

class RealMapper implements Mapper {
  constructor(readonly platform: SleepmePlatform) {
  }

  toCurrentHeatingCoolingState(status: DeviceStatus): 0 | 1 | 2 {
    const {OFF, COOL, HEAT} = this.platform.Characteristic.CurrentHeatingCoolingState;
    if (status.control.thermal_control_status === 'standby') {
      return OFF;
    }
    if (status.control.set_temperature_c <= status.status.water_temperature_c) {
      return COOL;
    }
    return HEAT;
  }

  toTargetHeatingCoolingState(status: DeviceStatus): 0 | 3 {
    const {OFF, AUTO} = this.platform.Characteristic.TargetHeatingCoolingState;
    return status.control.thermal_control_status === 'standby' ?
      OFF :
      AUTO;
  }

  toTemperatureDisplayUnits(status: DeviceStatus): 0 | 1 {
    return status.control.display_temperature_unit === 'c' ? 0 : 1;
  }
}

export function NewMapper(platform: SleepmePlatform): Mapper {
  return new RealMapper(platform);
}

