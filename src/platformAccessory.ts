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
  active_polling_interval_seconds?: number;
  standby_polling_interval_minutes?: number;
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

// Default polling intervals
const DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS = 45;   // 45 seconds when device is active
const DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES = 15;  // 15 minutes when device is in standby
const INITIAL_RETRY_DELAY_MS = 15000;                 // 15 seconds for first retry
const MAX_RETRIES = 3;                                // Maximum number of retry attempts
const STATE_MISMATCH_RETRY_DELAY_MS = 5000;           // 5 seconds between state mismatch retries
const MAX_STATE_MISMATCH_RETRIES = 3;                 // Maximum retries for state mismatches
const HIGH_TEMP_THRESHOLD_F = 115;
const HIGH_TEMP_TARGET_F = 999;
const LOW_TEMP_THRESHOLD_F = 55;
const LOW_TEMP_TARGET_F = -1;

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private deviceStatus: DeviceStatus | null;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private readonly activePollingIntervalMs: number;
  private readonly standbyPollingIntervalMs: number;
  private previousHeatingCoolingState: number | null = null;
  private expectedThermalState: 'standby' | 'active' | null = null; // Track expected state

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    const client = new Client(apiKey, undefined, this.platform.log);
    this.deviceStatus = null;

    // Get configuration
    const config = this.platform.config as PlatformConfig;
    this.waterLevelType = config.water_level_type || 'battery';
    
    // Set up active polling interval from config or use default
    const configuredActiveSeconds = config.active_polling_interval_seconds;
    if (configuredActiveSeconds !== undefined) {
      if (configuredActiveSeconds < 5) {
        this.platform.log.warn(`Active polling interval must be at least 5 seconds. Using 5 seconds.`);
        this.activePollingIntervalMs = 5 * 1000;
      } else {
        this.activePollingIntervalMs = configuredActiveSeconds * 1000;
        this.platform.log.debug(`Using configured active polling interval of ${configuredActiveSeconds} seconds`);
      }
    } else {
      this.activePollingIntervalMs = DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS * 1000;
      this.platform.log.debug(`Using default active polling interval of ${DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS} seconds`);
    }

    // Set up standby polling interval from config or use default
    const configuredStandbyMinutes = config.standby_polling_interval_minutes;
    if (configuredStandbyMinutes !== undefined) {
      if (configuredStandbyMinutes < 1) {
        this.platform.log.warn(`Standby polling interval must be at least 1 minute. Using 1 minute.`);
        this.standbyPollingIntervalMs = 60 * 1000;
      } else {
        this.standbyPollingIntervalMs = configuredStandbyMinutes * 60 * 1000;
        this.platform.log.debug(`Using configured standby polling interval of ${configuredStandbyMinutes} minutes`);
      }
    } else {
      this.standbyPollingIntervalMs = DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES * 60 * 1000;
      this.platform.log.debug(`Using default standby polling interval of ${DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES} minutes`);
    }

    // Debug log the startup state and configuration
    this.platform.log.debug(`Initializing ${this.accessory.displayName}`);
    this.platform.log.debug('Configuration:', JSON.stringify(config));
    this.platform.log.debug(`Water level type configured as: ${this.waterLevelType}`);
    this.platform.log.debug(`Active polling interval: ${this.activePollingIntervalMs/1000} seconds`);
    this.platform.log.debug(`Standby polling interval: ${this.standbyPollingIntervalMs/60000} minutes`);

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

    // Set up polling based on initial unknown state
    // We'll use the active polling rate initially until we know the device state
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

  // Helper method to handle thermal state mismatches
  private handleStateMismatch(
    client: Client, 
    device: Device, 
    expectedState: 'standby' | 'active', 
    actualState: 'standby' | 'active',
    retryCount: number = 0
  ): Promise<Control> {
    if (retryCount >= MAX_STATE_MISMATCH_RETRIES) {
      this.platform.log.warn(`${this.accessory.displayName}: State mismatch persisted after ${MAX_STATE_MISMATCH_RETRIES} retries. API returned ${actualState}, expected ${expectedState}. Accepting API state.`);
      // Reset the expected state since we're accepting the API state
      this.expectedThermalState = null;
      // Return the control with the actual state
      return Promise.resolve({ 
        ...this.deviceStatus!.control,
        thermal_control_status: actualState
      } as Control);
    }

    this.platform.log.warn(`${this.accessory.displayName}: State mismatch detected! API returned ${actualState}, expected ${expectedState}. Retrying (${retryCount + 1}/${MAX_STATE_MISMATCH_RETRIES})`);

    // Wait and retry setting the state
    return new Promise(resolve => setTimeout(resolve, STATE_MISMATCH_RETRY_DELAY_MS))
      .then(() => client.setThermalControlStatus(device.id, expectedState))
      .then(r => {
        const responseState = r.data.thermal_control_status;
        if (responseState === expectedState) {
          this.platform.log.info(`${this.accessory.displayName}: Successfully set state to ${expectedState} after retry`);
          this.expectedThermalState = null; // Reset expected state now that it matches
          return r.data;
        } else {
          // Still mismatched, retry again
          return this.handleStateMismatch(client, device, expectedState, responseState, retryCount + 1);
        }
      });
  }

  // Helper method to clamp temperature values to valid range for HomeKit
  private clampTemperature(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
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
        this.platform.log(`${this.accessory.displayName}: HomeKit state changed to ${targetState}`);
        
        // Store the expected state
        this.expectedThermalState = targetState;
        
        // Optimistically update the local state first for immediate HomeKit feedback
        if (this.deviceStatus) {
          this.deviceStatus.control.thermal_control_status = targetState;
          // Trigger UI update without waiting for API
          this.publishUpdates();
          
          // When the device state changes, we should update the polling interval immediately
          this.scheduleNextPollBasedOnState();
        }
        
        // Then actually send the command to the API with retry support
        const setThermalControlOperation = () => client.setThermalControlStatus(device.id, targetState);
        
        this.retryApiCall(
          setThermalControlOperation,
          this.accessory.displayName,
          "set thermal control status"
        )
        .then(r => {
          const responseState = r.data.thermal_control_status;
          
          // Check if the response state matches the expected state
          if (responseState !== targetState && this.expectedThermalState === targetState) {
            // State mismatch detected - handle it with multiple retries
            return this.handleStateMismatch(client, device, targetState, responseState);
          } else {
            this.expectedThermalState = null; // Reset expected state since it matches
            return r.data;
          }
        })
        .then(controlData => {
          // Only update based on API response if the state was successfully set
          this.updateControlFromResponse({ data: controlData });
        })
        .catch(error => {
          this.platform.log.error(`${this.accessory.displayName}: Failed to set thermal control state after retries: ${error instanceof Error ? error.message : String(error)}`);
          // If the API fails, revert our optimistic update by getting the actual device status
          return client.getDeviceStatus(device.id)
            .then(statusResponse => {
              this.deviceStatus = statusResponse.data;
              this.expectedThermalState = null; // Clear the expected state
              this.publishUpdates();
              // Update the polling schedule based on the actual state
              this.scheduleNextPollBasedOnState();
            })
            .catch(refreshError => {
              this.platform.log.error(`${this.accessory.displayName}: Failed to refresh status after error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
            });
        });
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => this.clampTemperature(ds.status.water_temperature_c, 12, 46.7))
        .orElse(21));

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
          // Ensure the reported temperature is within the valid range
          return this.clampTemperature(tempC, 12, 46.7);
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

  // New method to determine which polling interval to use based on device state
  private getPollingIntervalBasedOnState(): number {
    if (!this.deviceStatus) {
      // If we don't know the state yet, use active polling rate
      this.platform.log.debug(`${this.accessory.displayName}: No device status yet, using active polling interval`);
      return this.activePollingIntervalMs;
    }
    
    const isActive = this.deviceStatus.control.thermal_control_status === 'active';
    const interval = isActive ? this.activePollingIntervalMs : this.standbyPollingIntervalMs;
    
    this.platform.log.debug(`${this.accessory.displayName}: Device is ${isActive ? 'ACTIVE' : 'STANDBY'}, using ${interval/1000} second polling interval`);
    return interval;
  }

  // New method to immediately update polling schedule based on current state
  private scheduleNextPollBasedOnState(): void {
    // Clear existing timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    
    // Get the appropriate polling interval based on state
    const pollingInterval = this.getPollingIntervalBasedOnState();
    
    this.platform.log.debug(`${this.accessory.displayName}: Rescheduling polling with ${pollingInterval/1000}s interval based on current state`);
    
    // Schedule the next poll with the new interval
    this.scheduleNextCheck(async () => {
      const {apiKey, device} = this.accessory.context as SleepmeContext;
      const client = new Client(apiKey, undefined, this.platform.log);
      this.platform.log.debug(`Polling device status for ${this.accessory.displayName}`);
      const r = await client.getDeviceStatus(device.id);
      this.platform.log.debug(`Response (${this.accessory.displayName}): ${r.status}`);
      return r.data;
    });
  }

  private scheduleNextCheck(poller: () => Promise<DeviceStatus>) {
    // Get the appropriate polling interval based on current state
    const pollingInterval = this.getPollingIntervalBasedOnState();
    
    this.platform.log.debug(`${this.accessory.displayName}: Scheduling next poll in ${pollingInterval/1000}s`);
    
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
        const previousState = this.deviceStatus?.control.thermal_control_status;
        this.deviceStatus = s;
        
        // Check if we're waiting for a specific thermal state
        if (this.expectedThermalState !== null && s.control.thermal_control_status !== this.expectedThermalState) {
          this.platform.log.warn(`${this.accessory.displayName}: Device state (${s.control.thermal_control_status}) does not match expected state (${this.expectedThermalState}) during polling`);
          // Don't update HomeKit with the mismatched state - we'll keep the optimistic state
          // But do update everything else
          const savedState = this.expectedThermalState;
          if (this.deviceStatus) {
            this.deviceStatus.control.thermal_control_status = savedState;
          }
        } else if (this.expectedThermalState !== null && s.control.thermal_control_status === this.expectedThermalState) {
          // State now matches what we expected - we can clear the expected state flag
          this.platform.log.info(`${this.accessory.displayName}: Device state now matches expected state (${this.expectedThermalState})`);
          this.expectedThermalState = null;
        }
        
        // Check if device state has changed, which would affect polling interval
        const currentState = this.deviceStatus.control.thermal_control_status;
        if (previousState !== currentState) {
          this.platform.log.info(`${this.accessory.displayName}: Device state changed from ${previousState || 'unknown'} to ${currentState}, adjusting polling interval`);
          // Update UI first
          this.publishUpdates();
          // Then reschedule with the new appropriate interval
          this.scheduleNextPollBasedOnState();
          return; // Skip the normal schedule since we're rescheduling with a different interval
        }
        
        this.publishUpdates();
        this.platform.log.debug(`${this.accessory.displayName}: Current thermal control status: ${s.control.thermal_control_status}`);
        
        // Schedule next poll with the same interval
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
    if (!this.deviceStatus) {
      return;
    }
    
    // Check if the response state matches the expected state (if we have one)
    if (this.expectedThermalState !== null && response.data.thermal_control_status !== this.expectedThermalState) {
      this.platform.log.warn(`${this.accessory.displayName}: API returned ${response.data.thermal_control_status}, but expected ${this.expectedThermalState}. Not updating HomeKit.`);
      // Don't update with the mismatched state
      return;
    }
    
    // Clear any expected state since the response matches (or we didn't have an expectation)
    this.expectedThermalState = null;
    
    const previousState = this.deviceStatus.control.thermal_control_status;
    this.deviceStatus.control = response.data;
    this.platform.log(`${this.accessory.displayName}: API confirmed state: ${response.data.thermal_control_status.toUpperCase()}`);
    
    // If thermal state changed, update polling interval
    if (previousState !== response.data.thermal_control_status) {
      this.scheduleNextPollBasedOnState();
    }
    
    this.publishUpdates();
  }
  
  // Publishes all characteristic updates to HomeKit
  private publishUpdates(): void {
    if (!this.deviceStatus) {
      return;
    }
    
    const { Characteristic } = this.platform;
    
    // Update thermostat characteristics
    this.thermostatService.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      newMapper(this.platform).toHeatingCoolingState(this.deviceStatus)
    );
    
    this.thermostatService.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      this.deviceStatus.control.thermal_control_status === 'standby' ? 
        Characteristic.TargetHeatingCoolingState.OFF : 
        Characteristic.TargetHeatingCoolingState.AUTO
    );
    
    const currentTemp = this.clampTemperature(this.deviceStatus.status.water_temperature_c, 12, 46.7);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
    
    // Determine target temperature value considering special cases
    let targetTemp = this.deviceStatus.control.set_temperature_c;
    if (this.deviceStatus.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
      targetTemp = 46.7; // Maximum allowed Celsius temperature
    } else if (this.deviceStatus.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
      targetTemp = 12.2; // Minimum allowed temperature
    }
    
    // Apply valid range clamping
    targetTemp = this.clampTemperature(targetTemp, 12, 46.7);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, targetTemp);
    
    this.thermostatService.updateCharacteristic(
      Characteristic.TemperatureDisplayUnits,
      this.deviceStatus.control.display_temperature_unit === 'c' ? 0 : 1
    );
    
    // Update water level characteristics based on service type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.LeakDetected,
        this.deviceStatus.status.is_water_low ? 
          Characteristic.LeakDetected.LEAK_DETECTED : 
          Characteristic.LeakDetected.LEAK_NOT_DETECTED
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.MotionDetected,
        this.deviceStatus.status.is_water_low
      );
    } else {
      // Battery service
      this.waterLevelService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        this.deviceStatus.status.is_water_low
      );
      
      this.waterLevelService.updateCharacteristic(
        Characteristic.BatteryLevel,
        this.deviceStatus.status.water_level
      );
    }
    
    // Log the state update if needed
    const state = this.deviceStatus.control.thermal_control_status;
    const temp = this.deviceStatus.control.set_temperature_f;
    const waterLevel = this.deviceStatus.status.water_level;
    
    this.platform.log.debug(
      `${this.accessory.displayName}: Updated HomeKit - State: ${state.toUpperCase()}, Temp: ${temp}°F, Water: ${waterLevel}%`
    );
  }}