// filename: src/platformAccessory.ts
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
const LOW_TEMP_THRESHOLD_F = 55;
const LOW_TEMP_TARGET_F = -1;
const INITIAL_RETRY_DELAY_MS = 15000; // 15 seconds for first retry
const MAX_RETRIES = 3; // Maximum number of retry attempts

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private readonly slowPollingIntervalMs: number;
  private previousHeatingCoolingState: number | null = null;
  private isStartup = true; // Add a flag to track initial startup

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Set lastInteractionTime to 2 hours in the past to ensure slow polling on startup
    const pastTime = new Date();
    pastTime.setHours(pastTime.getHours() - 2);
    this.lastInteractionTime = pastTime;
    
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    const client = new Client(apiKey, undefined, this.platform.log);
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

    // Debug log the startup state and configuration
    this.platform.log.debug(`Initializing ${this.accessory.displayName} with forced slow polling on startup`);
    this.platform.log.debug(`Initial lastInteractionTime set to ${this.lastInteractionTime}`);
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
      })
      .catch(error => {
        this.platform.log.error(`Failed to get initial device status for ${this.accessory.displayName}: ${error instanceof Error ? error.message : String(error)}`);
        // Still continue with setup, we'll retry on the next polling cycle
      });

    // Set up polling with forced slow mode on startup
    this.scheduleNextCheck(async () => {
      this.platform.log.debug(`Polling device status for ${this.accessory.displayName}`)
      const r = await client.getDeviceStatus(device.id);
      this.platform.log.debug(`Response (${this.accessory.displayName}): ${r.status}`)
      return r.data
    });
  }

  // Update the retry helper method in the SleepmePlatformAccessory class
  private retryApiCall<T>(
    operation: () => Promise<T>, 
    deviceName: string, 
    operationName: string, 
    maxRetries: number = MAX_RETRIES, 
    currentAttempt: number = 1
  ): Promise<T> {
    return operation().catch(error => {
      // Retry on any error, not just rate limits
      if (currentAttempt <= maxRetries) {
        // Calculate exponential backoff delay: 15s, 30s, 60s
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentAttempt - 1);
        
        // Format error message based on status code if available
        let errorDetails = error instanceof Error ? error.message : String(error);
        const statusCode = (error as any).statusCode;
        if (statusCode) {
          errorDetails = `HTTP ${statusCode}: ${errorDetails}`;
        }
        
        this.platform.log.warn(
          `${deviceName}: Failed to ${operationName} (${errorDetails}). Retrying in ${delay/1000}s (attempt ${currentAttempt}/${maxRetries})`
        );
        
        // Wait and then retry with exponential backoff
        return new Promise(resolve => setTimeout(resolve, delay))
          .then(() => this.retryApiCall(
            operation, 
            deviceName,
            operationName,
            maxRetries,
            currentAttempt + 1
          ));
      }
      
      // If we've exhausted retries, rethrow
      throw error;
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
        this.platform.log(`${this.accessory.displayName}: setting TargetHeatingCoolingState to ${targetState} (${value})`);
        
        // Optimistically update the local state first for immediate HomeKit feedback
        if (this.deviceStatus) {
          this.deviceStatus.control.thermal_control_status = targetState;
          // Trigger UI update without waiting for API
          this.publishUpdates();
        }
        
        // Then actually send the command to the API with retry support
        const setThermalControlOperation = () => client.setThermalControlStatus(device.id, targetState);
        
        this.retryApiCall(
          setThermalControlOperation,
          this.accessory.displayName,
          "set thermal control status"
        )
        .then(r => {
          this.platform.log(`${this.accessory.displayName}: API response: ${r.status}`);
          // Update with the actual API response
          this.updateControlFromResponse(r);
        })
        .catch(error => {
          this.platform.log.error(`${this.accessory.displayName}: Failed to set thermal control state after retries: ${error instanceof Error ? error.message : String(error)}`);
          // If the API fails, revert our optimistic update by getting the actual device status
          return client.getDeviceStatus(device.id)
            .then(statusResponse => {
              this.deviceStatus = statusResponse.data;
              this.publishUpdates();
            })
            .catch(refreshError => {
              this.platform.log.error(`${this.accessory.displayName}: Failed to refresh status after error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
            });
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
          // Handle both high and low special temperature cases
          if (ds.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
            return 46.7; // Maximum allowed Celsius temperature
          } else if (ds.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
            return 12.2; // 54°F in Celsius
          }
          const tempC = ds.control.set_temperature_c;
          const tempF = (tempC * (9/5)) + 32;
          this.platform.log(`${this.accessory.displayName}: Current target temperature: ${tempC}°C (${tempF.toFixed(1)}°F)`);
          return tempC;
        })
        .orElse(21))
      .onSet(async (value: CharacteristicValue) => {
        const tempC = value as number;
        let tempF = (tempC * (9 / 5)) + 32;
        
        // Round to nearest whole number for API call
        tempF = Math.round(tempF);
        
        // Optimistically update the local state first for immediate HomeKit feedback
        if (this.deviceStatus) {
          // Update the local temperature values
          this.deviceStatus.control.set_temperature_c = tempC;
          this.deviceStatus.control.set_temperature_f = tempF;
          
          // Handle special temperature cases
          let apiTemp = tempF;
          if (tempF > HIGH_TEMP_THRESHOLD_F) {
            this.platform.log(`${this.accessory.displayName}: Temperature over ${HIGH_TEMP_THRESHOLD_F}F, mapping to ${HIGH_TEMP_TARGET_F}F for API call`);
            apiTemp = HIGH_TEMP_TARGET_F;
          } else if (tempF < LOW_TEMP_THRESHOLD_F) {
            this.platform.log(`${this.accessory.displayName}: Temperature under ${LOW_TEMP_THRESHOLD_F}F, mapping to ${LOW_TEMP_TARGET_F}F for API call`);
            apiTemp = LOW_TEMP_TARGET_F;
          } else {
            this.platform.log(`${this.accessory.displayName}: Setting temperature to: ${tempC}°C (${tempF}°F)`);
          }
          
          // Trigger UI update without waiting for API
          this.publishUpdates();
          
          // Create the API operation function with the correct temperature
          const setTemperatureOperation = () => client.setTemperatureFahrenheit(device.id, apiTemp);
          
          // Call the API with retry support
          this.retryApiCall(
            setTemperatureOperation,
            this.accessory.displayName,
            "set temperature"
          )
          .then(() => {
            // Get the full updated status after successful temperature change
            return client.getDeviceStatus(device.id);
          })
          .then(statusResponse => {
            this.deviceStatus = statusResponse.data;
            this.publishUpdates();
            this.platform.log(`${this.accessory.displayName}: Successfully updated temperature from API`);
          })
          .catch(error => {
            this.platform.log.error(`${this.accessory.displayName}: Failed to set temperature after retries: ${error instanceof Error ? error.message : String(error)}`);
            // If the API fails after all retries, refresh the status to get the actual state
            return client.getDeviceStatus(device.id)
              .then(statusResponse => {
                this.deviceStatus = statusResponse.data;
                this.publishUpdates();
              })
              .catch(refreshError => {
                this.platform.log.error(`${this.accessory.displayName}: Failed to refresh status after error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
              });
          });
        }
      });

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));
  }

  private scheduleNextCheck(poller: () => Promise<DeviceStatus>) {
    // Force slow polling on the first call (startup)
    const useSlowPollingOnStartup = this.isStartup;
    if (this.isStartup) {
      this.isStartup = false; // Clear the startup flag after first use
      this.platform.log.debug(`${this.accessory.displayName}: Initial poll - FORCING slow polling mode`);
    }
    
    const timeSinceLastInteractionMS = new Date().valueOf() - this.lastInteractionTime.valueOf();
    const usesFastPolling = !useSlowPollingOnStartup && (timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS);
    const pollingInterval = usesFastPolling ? FAST_POLLING_INTERVAL_MS : this.slowPollingIntervalMs;
    
    this.platform.log.debug(`${this.accessory.displayName}: Scheduling next poll in ${pollingInterval/1000}s (${usesFastPolling ? 'FAST' : 'SLOW'} polling mode)`);
    this.platform.log.debug(`${this.accessory.displayName}: Last interaction was ${timeSinceLastInteractionMS/1000}s ago at ${this.lastInteractionTime}`);
    
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.platform.log.debug(`${this.accessory.displayName}: Polling at: ${new Date()}`);
      
      // Use the retry mechanism for polling as well
      const getStatusOperation = () => poller();
      
      this.retryApiCall(
        getStatusOperation,
        this.accessory.displayName,
        "poll device status"
      )
      .then(s => {
        this.deviceStatus = s;
        this.publishUpdates();
        this.platform.log.debug(`${this.accessory.displayName}: Current thermal control status: ${s.control.thermal_control_status}`);
      })
      .then(() => {
        this.scheduleNextCheck(poller);
      })
      .catch(error => {
        this.platform.log.error(`${this.accessory.displayName}: Error polling device after retries: ${error instanceof Error ? error.message : String(error)}`);
        // Still schedule next check even if there was an error after all retries
        this.scheduleNextCheck(poller);
      });
    }, pollingInterval);
  }

  private updateControlFromResponse(response: { data: Control }) {
    if (this.deviceStatus) {
      this.deviceStatus.control = response.data;
      this.platform.log(`${this.accessory.displayName}: Updated control status: ${response.data.thermal_control_status}`);
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
    
    // Log current water temperature in both units
    const currentTempC = s.status.water_temperature_c;
    const currentTempF = (currentTempC * (9/5)) + 32;
    this.platform.log(`${this.accessory.displayName}: Current temperature: ${currentTempC}°C (${currentTempF.toFixed(1)}°F)`);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, currentTempC);

    // Handle both high and low temperature special cases
    const targetTempF = s.control.set_temperature_f;
    let displayTempC;
    if (targetTempF >= HIGH_TEMP_TARGET_F) {
      displayTempC = 46.7;
    } else if (targetTempF <= LOW_TEMP_TARGET_F) {
      displayTempC = 12.2; // 54°F in Celsius
    } else {
      displayTempC = s.control.set_temperature_c;
    }
    this.platform.log(`${this.accessory.displayName}: Target temperature: ${displayTempC}°C (${targetTempF}°F)`);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, displayTempC);

    if (this.previousHeatingCoolingState !== currentState) {
      const wasOff = this.previousHeatingCoolingState === 0;
      const isOff = currentState === 0;
      if (wasOff || isOff) {
        const stateText = isOff ? "STANDBY" : "ON";
        this.platform.log(`${this.accessory.displayName}: Updated state to ${stateText}`);
      }
      this.previousHeatingCoolingState = currentState;
    }
  }
}