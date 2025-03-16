// filename: src/sleepme/client.ts
import axios, {AxiosInstance, AxiosResponse, AxiosError} from 'axios';
import {Logging} from 'homebridge';

type ClientResponse<T> = {
  data: T;
  status: number;
};

export class Client {
  readonly token: string;
  private readonly axiosClient: AxiosInstance
  private readonly log?: Logging;

  constructor(token: string, baseURL = 'https://api.developer.sleep.me', log?: Logging) {
    this.token = token;
    this.axiosClient = axios.create({baseURL: baseURL});
    this.log = log;
  }

  headers(): object {
    return {
      'Authorization': `Bearer ${this.token}`,
    };
  }

  private logResponse<T>(response: AxiosResponse<T>, method: string, endpoint: string): void {
    if (this.log) {
      this.log.debug(`API ${method} ${endpoint} - Response Code: ${response.status}`);
    }
  }

  private handleError(error: unknown, method: string, endpoint: string): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const statusText = axiosError.response?.statusText || 'Unknown error';
      
      if (this.log) {
        if (status === 429) {
          this.log.error(`API ${method} ${endpoint} - RATE LIMITED (429): Too many requests. Consider increasing your polling interval.`);
        } else {
          this.log.error(`API ${method} ${endpoint} - Error ${status}: ${statusText}`);
        }
        
        // Log response details if available
        if (axiosError.response?.data) {
          try {
            const data = typeof axiosError.response.data === 'object' 
              ? JSON.stringify(axiosError.response.data) 
              : String(axiosError.response.data);
            this.log.debug(`API error details: ${data}`);
          } catch {
            // Ignore stringification errors
          }
        }
      }
      
      // Rethrow a safer error that won't crash Homebridge
      throw new Error(`API error ${status}: ${statusText}`);
    } else {
      // For non-axios errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.log) {
        this.log.error(`API ${method} ${endpoint} - Unexpected error: ${errorMessage}`);
      }
      throw new Error(`API error: ${errorMessage}`);
    }
  }
  
  async listDevices(): Promise<ClientResponse<Device[]>> {
    const endpoint = '/v1/devices';
    try {
      const response = await this.axiosClient.get<Device[]>(endpoint, {headers: this.headers()});
      this.logResponse(response, 'GET', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'GET', endpoint);
    }
  }

  async getDeviceStatus(id: string): Promise<ClientResponse<DeviceStatus>> {
    const endpoint = `/v1/devices/${id}`;
    try {
      const response = await this.axiosClient.get<DeviceStatus>(endpoint, {headers: this.headers()});
      this.logResponse(response, 'GET', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'GET', endpoint);
    }
  }

  async setTemperatureFahrenheit(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint, 
        {set_temperature_f: temperature},
        {headers: this.headers()}
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }

  async setTemperatureCelsius(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint, 
        {set_temperature_c: temperature},
        {headers: this.headers()}
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }

  async setThermalControlStatus(id: string, targetState: 'standby' | 'active'): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint, 
        {thermal_control_status: targetState},
        {headers: this.headers()}
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }
}

export type Device = {
  id: string;
  name: string;
  attachments: string[];
};

export type Control = {
  brightness_level: number;
  display_temperature_unit: 'c' | 'f';
  set_temperature_c: number;
  set_temperature_f: number;
  thermal_control_status: 'standby' | 'active';
  time_zone: string;
};

export type DeviceStatus = {
  about: {
    firmware_version: string;
    ip_address: string;
    lan_address: string;
    mac_address: string;
    model: string;
    serial_number: string;
  };
  control: Control;
  status: {
    is_connected: boolean;
    is_water_low: boolean;
    water_level: number;
    water_temperature_f: number;
    water_temperature_c: number;
  };
};