import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, Control, Device, DeviceStatus} from './sleepme/client.js';

type SleepmeContext = {
  device: Device;
  apiKey: string;
};

interface PlatformConfig {
  water_level_type?: 'battery' | 'leak' | 'motion';
  virtual_temperature_boost_switch?: boolean;
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
const SLOW_POLLING_INTERVAL_MS = 15 * 60 * 1000;
const POLLING_RECENCY_THRESHOLD_MS = 5 * 1000;

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private highModeService: Service;
  private tempBoostService?: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private tempBoostEnabled: boolean = false;
  private readonly TEMP_BOOST_AMOUNT = 20;
  private readonly HIGH_MODE_TEMP = 999;
  private readonly hasTemperatureBoost: boolean;

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
    this.hasTemperatureBoost = config.virtual_temperature_boost_switch === true;

    if (this.hasTemperatureBoost) {
      this.platform.log.debug('Temperature boost switch enabled in config');
    }

    // Initialize service bindings first
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat, `${this.accessory.displayName} - Dock Pro`);

    this.highModeService = this.accessory.getService('High Mode') ||
      this.accessory.addService(this.platform.Service.Switch, 'High Mode', 'high-mode');

    // Remove any existing water level services first
    const existingBatteryService = this.accessory.getService(this.platform.Service.Battery);
    const existingLeakService = this.accessory.getService(this.platform.Service.LeakSensor);
    const existingMotionService = this.accessory.getService(this.platform.Service.MotionSensor);
    const existingBoostService = this.accessory.getService('Temperature Boost');
    
    if (existingBatteryService) {
      this.accessory.removeService(existingBatteryService);
    }
    if (existingLeakService) {
      this.accessory.removeService(existingLeakService);
    }
    if (existingMotionService) {
      this.accessory.removeService(existingMotionService);
    }
    if (existingBoostService && !this.hasTemperatureBoost) {
      this.accessory.removeService(existingBoostService);
    }

    // Add the appropriate water level service based on configuration
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

    // Initialize HIGH mode switch characteristics
    this.highModeService.getCharacteristic(Characteristic.On)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.set_temperature_f >= this.HIGH_MODE_TEMP)
        .orElse(false))
      .onSet(async (value: CharacteristicValue) => {
        if (value) {
          return client.setTemperatureFahrenheit(device.id, this.HIGH_MODE_TEMP)
            .then(r => {
              this.platform.log(`HIGH mode enabled for ${this.accessory.displayName}`);
              this.updateControlFromResponse(r);
            });
        } else {
          const defaultTemp = 85;
          return client.setTemperatureFahrenheit(device.id, defaultTemp)
            .then(r => {
              this.platform.log(`HIGH mode disabled for ${this.accessory.displayName}`);
              this.updateControlFromResponse(r);
            });
        }
      });

    // Initialize temperature boost switch if enabled
    if (this.hasTemperatureBoost) {
      this.tempBoostService = this.accessory.getService('Temperature Boost') ||
        this.accessory.addService(this.platform.Service.Switch, 'Temperature Boost', 'temp-boost');

      this.tempBoostService.getCharacteristic(Characteristic.On)
        .onGet(() => this.tempBoostEnabled)
        .onSet((value: CharacteristicValue) => {
          this.tempBoostEnabled = value as boolean;
          this.platform.log(`Temperature boost ${value ? 'enabled' : 'disabled'} for ${this.accessory.displayName}`);
          this.publishUpdates();
        });
    }

    // Initialize thermostat characteristics
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => newMapper(this.platform).toHeatingCoolingState(ds))
        .orElse(0));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => newMapper(this.platform).toHeatingCoolingState(ds))
        .orElse(0))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === 0) ? 'standby' : 'active';
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
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => {
          const tempC = ds.control.set_temperature_c;
          if (ds.control.set_temperature_f >= this.HIGH_MODE_TEMP) {
            return 38;
          }
          return this.hasTemperatureBoost && this.tempBoostEnabled ? 
            tempC - (this.TEMP_BOOST_AMOUNT * 5/9) : tempC;
        })
        .orElse(10))
      .onSet(async (value: CharacteristicValue) => {
        const adjustedValue = this.hasTemperatureBoost && this.tempBoostEnabled ? 
          (value as number) + (this.TEMP_BOOST_AMOUNT * 5/9) : 
          value as number;
        
        const tempF = Math.floor((adjustedValue * (9 / 5)) + 32);
        this.platform.log(`setting TargetTemperature for ${this.accessory.displayName} to ${tempF}F (${adjustedValue}C)`);
        
        return client.setTemperatureFahrenheit(device.id, tempF)
          .then(r => {
            this.platform.log(`response (${this.accessory.displayName}): ${r.status}`);
            this.updateControlFromResponse(r);
          });
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
    }, timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS ? FAST_POLLING_INTERVAL_MS : SLOW_POLLING_INTERVAL_MS);
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

    // Update HIGH mode switch
    const isHighMode = s.control.set_temperature_f >= this.HIGH_MODE_TEMP;
    this.highModeService.updateCharacteristic(Characteristic.On, isHighMode);

    // Update temperature boost switch if it exists
    if (this.hasTemperatureBoost && this.tempBoostService) {
      this.tempBoostService.updateCharacteristic(Characteristic.On, this.tempBoostEnabled);
    }

    // Update thermostat characteristics with boost adjustment
    let displayTargetTemp = s.control.set_temperature_c;
    if (isHighMode) {
      displayTargetTemp = 38;
    } else if (this.hasTemperatureBoost && this.tempBoostEnabled) {
      displayTargetTemp -= (this.TEMP_BOOST_AMOUNT * 5/9);
    }

    this.thermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, 
      s.control.display_temperature_unit === 'c' ? 0 : 1);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentState);
    this.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, currentState);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, s.status.water_temperature_c);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, displayTargetTemp);
    
    this.platform.log(`Updated heating/cooling state to: ${currentState} (0=OFF, 1=HEAT, 2=COOL)`);
    if (this.hasTemperatureBoost) {
      this.platform.log(`Temperature boost enabled: ${this.tempBoostEnabled}, High mode: ${isHighMode}`);
    } else {
      this.platform.log(`High mode: ${isHighMode}`);
    }
  }
}