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

// ... (keeping mapper and other interfaces unchanged)

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private highModeService: Service;
  private tempBoostService?: Service; // Made optional
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

    // ... (keeping existing initialization code)

    // Add HIGH mode switch service (always enabled)
    this.highModeService = this.accessory.getService('High Mode') ||
      this.accessory.addService(Service.Switch, 'High Mode', 'high-mode');

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

    // Add temperature boost switch service only if enabled in config
    if (this.hasTemperatureBoost) {
      this.tempBoostService = this.accessory.getService('Temperature Boost') ||
        this.accessory.addService(Service.Switch, 'Temperature Boost', 'temp-boost');

      this.tempBoostService.getCharacteristic(Characteristic.On)
        .onGet(() => this.tempBoostEnabled)
        .onSet((value: CharacteristicValue) => {
          this.tempBoostEnabled = value as boolean;
          this.platform.log(`Temperature boost ${value ? 'enabled' : 'disabled'} for ${this.accessory.displayName}`);
          this.publishUpdates();
        });
    } else {
      // Remove the temperature boost service if it exists but is no longer enabled
      const existingBoostService = this.accessory.getService('Temperature Boost');
      if (existingBoostService) {
        this.accessory.removeService(existingBoostService);
      }
    }

    // Modify the existing TargetTemperature characteristic handler
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

    // ... (keeping rest of the constructor unchanged)
  }

  private publishUpdates() {
    const s = this.deviceStatus;
    if (!s) {
      return;
    }

    const {Characteristic} = this.platform;
    const mapper = newMapper(this.platform);
    
    const currentState = mapper.toHeatingCoolingState(s);
    
    // Update water level service (keeping existing code)
    
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

  // ... (keeping other methods unchanged)
}