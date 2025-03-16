import axios, {AxiosInstance} from 'axios';
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
  
  async listDevices(): Promise<ClientResponse<Device[]>> {
    const endpoint = '/v1/devices';
    const response = await this.axiosClient.get<Device[]>(endpoint, {headers: this.headers()});
    this.logResponse(response, 'GET', endpoint);
    return response;
  }

  async getDeviceStatus(id: string): Promise<ClientResponse<DeviceStatus>> {
    const endpoint = `/v1/devices/${id}`;
    const response = await this.axiosClient.get<DeviceStatus>(endpoint, {headers: this.headers()});
    this.logResponse(response, 'GET', endpoint);
    return response;
  }

  async setTemperatureFahrenheit(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    const response = await this.axiosClient.patch<Control>(
      endpoint, 
      {set_temperature_f: temperature},
      {headers: this.headers()}
    );
    this.logResponse(response, 'PATCH', endpoint);
    return response;
  }

  async setTemperatureCelsius(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    const response = await this.axiosClient.patch<Control>(
      endpoint, 
      {set_temperature_c: temperature},
      {headers: this.headers()}
    );
    this.logResponse(response, 'PATCH', endpoint);
    return response;
  }

  async setThermalControlStatus(id: string, targetState: 'standby' | 'active'): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    const response = await this.axiosClient.patch<Control>(
      endpoint, 
      {thermal_control_status: targetState},
      {headers: this.headers()}
    );
    this.logResponse(response, 'PATCH', endpoint);
    return response;
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

