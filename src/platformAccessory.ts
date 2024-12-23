import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, Control, Device, DeviceStatus} from './sleepme/client.js';

type SleepmeContext = {
  device: Device;
  apiKey: string;
};

interface PlatformConfig {
  water_level_type?: 'battery' | 'leak' | 'motion';
  slow_polling_interval_minutes?: number;
}

interface Mapper {
  toHeatingCoolingState: (status: DeviceStatus) => 0 | 1 | 2;
}

function newMapper(platform: SleepmePlatform): Mapper {
  const {Characteristic} = platform;
  return {
    toHeatingCoolingState: (status: DeviceStatus): 0 | 1 | 2 => {
      if (status.control.thermal_control_status === 'standby') {
        return Characteristic.CurrentHeatingCoolingState.OFF;
      }
      
      const currentTemp = status.status.water_temperature_c;
      const targetTemp = status.control.set_temperature_c;
      
      if (targetTemp > currentTemp) {
        return Characteristic.CurrentHeatingCoolingState.HEAT;
      } else {
        return Characteristic.CurrentHeatingCoolingState.COOL;
      }
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
    return this.value as unknown as T;
  }
}

const FAST_POLLING_INTERVAL_MS = 15 * 1000;
const DEFAULT_SLOW_POLLING_INTERVAL_MINUTES = 15;
const POLLING_RECENCY_THRESHOLD_MS = 60 * 1000;
const HIGH_TEMP_THRESHOLD_F = 115;
const HIGH_TEMP_TARGET_F = 999;

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private readonly slowPollingIntervalMs: number;
  private previousHeatingCoolingState: number | null = null;

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.lastInteractionTime = new Date();
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    const client = new Client(apiKey);
    this.deviceStatus = null;

    // Get configuration
    const config = this.platform.config as PlatformConfig;
    this.waterLevelType = config.water_level_type || 'battery';
    
    // Set up polling interval from config or use default
    const configuredMinutes = config.slow_polling_interval_minutes;
    if (configuredMinutes !== undefined) {
      if (configuredMinutes < 1) {
        this.platform.log.warn('Slow polling interval must be at least 1 minute. Using 1 minute.');
        this.slowPollingIntervalMs = 60 * 1000;
      } else {
        this.slowPollingIntervalMs = configuredMinutes * 60 * 1000;
        this.platform.log.debug(`Using configured slow polling interval of ${configuredMinutes} minutes`);
      }
    } else {
      this.slowPollingIntervalMs = DEFAULT_SLOW_POLLING_INTERVAL_MINUTES * 60 * 1000;
      this.platform.log.debug(`Using default slow polling interval of ${DEFAULT_SLOW_POLLING_INTERVAL_MINUTES} minutes`);
    }

    // Debug log the configuration
    this.platform.log.debug('Configuration:', JSON.stringify(config));
    this.platform.log.debug(`Water level type configured as: ${this.waterLevelType}`);

    // Initialize service bindings first
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat, `${this.accessory.displayName} - Dock Pro`);

    // Remove any existing water level services first
    const existingBatteryService = this.accessory.getService(this.platform.Service.Battery);
    const existingLeakService = this.accessory.getService(this.platform.Service.LeakSensor);
    const existingMotionService = this.accessory.getService(this.platform.Service.MotionSensor);
    const existingHighModeService = this.accessory.getService('High Mode');
    const existingBoostService = this.accessory.getService('Temperature Boost');
    
    // Debug existing services
    this.platform.log.debug(`Existing services before removal:
      Battery: ${!!existingBatteryService}
      Leak: ${!!existingLeakService}
      Motion: ${!!existingMotionService}`);
    
    if (existingBatteryService) {
      this.platform.log.debug('Removing existing battery service');
      this.accessory.removeService(existingBatteryService);
    }
    if (existingLeakService) {
      this.platform.log.debug('Removing existing leak service');
      this.accessory.removeService(existingLeakService);
    }
    if (existingMotionService) {
      this.platform.log.debug('Removing existing motion service');
      this.accessory.removeService(existingMotionService);
    }
    if (existingHighModeService) {
      this.platform.log.debug('Removing existing high mode service');
      this.accessory.removeService(existingHighModeService);
    }
    if (existingBoostService) {
      this.platform.log.debug('Removing existing temperature boost service');
      this.accessory.removeService(existingBoostService);
    }

    // Add the appropriate water level service based on configuration
    this.platform.log.debug(`Creating new water level service of type: ${this.waterLevelType}`);
    if (this.waterLevelType === 'leak') {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.LeakSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.MotionSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.Battery,
        `${this.accessory.displayName} - Water Level`
      );
    }

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepme')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    // Initialize all characteristic handlers after services are created
    this.initializeCharacteristics(client, device);

    // Get initial device status
    client.getDeviceStatus(device.id)
      .then(statusResponse => {
        this.deviceStatus = statusResponse.data;
        this.publishUpdates();
      });

    // Set up polling
    this.scheduleNextCheck(async () => {
      this.platform.log(`polling device status for ${this.accessory.displayName}`)
      const r = await client.getDeviceStatus(device.id);
      this.platform.log(`response (${this.accessory.displayName}): ${r.status}`)
      return r.data
    });
  }

  private initializeCharacteristics(client: Client, device: Device) {
    const {Characteristic} = this.platform;

    // Initialize water level characteristics based on type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.getCharacteristic(Characteristic.LeakDetected)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low ? 
            Characteristic.LeakDetected.LEAK_DETECTED : 
            Characteristic.LeakDetected.LEAK_NOT_DETECTED)
          .orElse(Characteristic.LeakDetected.LEAK_NOT_DETECTED));
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.getCharacteristic(Characteristic.MotionDetected)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low)
          .orElse(false));
    } else {
      this.waterLevelService.getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low)
          .orElse(false));

      this.waterLevelService.getCharacteristic(Characteristic.BatteryLevel)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.water_level)
          .orElse(50));
    }

    // Initialize thermostat characteristics
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => newMapper(this.platform).toHeatingCoolingState(ds))
        .orElse(0));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,  // 0
          Characteristic.TargetHeatingCoolingState.AUTO  // 3
        ]
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.thermal_control_status === 'standby' ? 
          Characteristic.TargetHeatingCoolingState.OFF : 
          Characteristic.TargetHeatingCoolingState.AUTO)
        .orElse(Characteristic.TargetHeatingCoolingState.OFF))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === Characteristic.TargetHeatingCoolingState.OFF) ? 'standby' : 'active';
        this.platform.log(`setting TargetHeatingCoolingState for ${this.accessory.displayName} to ${targetState} (${value})`);
        
        return client.setThermalControlStatus(device.id, targetState)
          .then(r => {
            this.platform.log(`response (${this.accessory.displayName}): ${r.status}`);
            this.updateControlFromResponse(r);
          });
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.status.water_temperature_c)
        .orElse(-270));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 12,
        maxValue: 46.7,
        minStep: 0.5
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => {
          // If the actual set temperature is 999F, return the maximum allowed Celsius
          if (ds.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
            return 46.7; // Maximum allowed Celsius temperature
          }
          return ds.control.set_temperature_c;
        })
        .orElse(10))
      .onSet(async (value: CharacteristicValue) => {
        const tempC = value as number;
        let tempF = Math.floor((tempC * (9 / 5)) + 32);
        
        // Map temperatures over threshold to HIGH_TEMP_TARGET_F
        if (tempF > HIGH_TEMP_THRESHOLD_F) {
          this.platform.log(`Temperature over ${HIGH_TEMP_THRESHOLD_F}F, mapping to ${HIGH_TEMP_TARGET_F}F for API call`);
          await client.setTemperatureFahrenheit(device.id, HIGH_TEMP_TARGET_F);
        } else {
          await client.setTemperatureFahrenheit(device.id, tempF);
        }
        
        const r = await client.getDeviceStatus(device.id);
        this.deviceStatus = r.data;  // Update full device status
        this.publishUpdates();
      });

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));
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
        this.platform.log(`Current thermal control status: ${s.control.thermal_control_status}`);
      }).then(() => {
        this.scheduleNextCheck(poller);
      });
    }, timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS ? FAST_POLLING_INTERVAL_MS : this.slowPollingIntervalMs);
  }

  private updateControlFromResponse(response: { data: Control }) {
    if (this.deviceStatus) {
      this.deviceStatus.control = response.data;
      this.platform.log(`Updated control status: ${response.data.thermal_control_status}`);
    }
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
    
    const currentState = mapper.toHeatingCoolingState(s);
    
    // Update water level service based on type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.LeakDetected,
        s.status.is_water_low ?
          Characteristic.LeakDetected.LEAK_DETECTED : 
          Characteristic.LeakDetected.LEAK_NOT_DETECTED
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.MotionDetected,
        s.status.is_water_low
      );
    } else {
      this.waterLevelService.updateCharacteristic(Characteristic.BatteryLevel, s.status.water_level);
      this.waterLevelService.updateCharacteristic(Characteristic.StatusLowBattery, s.status.is_water_low);
    }

    // Update thermostat characteristics
    this.thermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, 
      s.control.display_temperature_unit === 'c' ? 0 : 1);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentState);
    this.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, 
      s.control.thermal_control_status === 'standby' ? 
        Characteristic.TargetHeatingCoolingState.OFF : 
        Characteristic.TargetHeatingCoolingState.AUTO);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, s.status.water_temperature_c);

    // If actual temperature is 999F, display maximum allowed temperature
    const displayTemp = s.control.set_temperature_f >= HIGH_TEMP_TARGET_F ? 46.7 : s.control.set_temperature_c;
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, displayTemp);
    
    // Only log if the heating/cooling state has changed
    if (this.previousHeatingCoolingState !== currentState) {
      this.platform.log(`Updated heating/cooling state to: ${currentState} (0=OFF, 1=HEAT, 2=COOL)`);
      this.previousHeatingCoolingState = currentState;
    }
  }
}