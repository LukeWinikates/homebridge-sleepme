import axios from 'axios';

type ClientResponse<T> = {
  data: T;
  status: number;
};

export class Client {
  readonly token: string;
  private readonly baseURL: string;

  constructor(token: string, baseURL = 'https://api.developer.sleep.me') {
    this.token = token;
    this.baseURL = baseURL;
  }

  headers(): object {
    return {
      'Authorization': `Bearer ${this.token}`,
    };
  }

  listDevices(): Promise<ClientResponse<Device[]>> {
    return axios.get<Device[]>(this.baseURL + '/v1/devices',
      {headers: this.headers()});
  }

  getDeviceStatus(id: string): Promise<ClientResponse<DeviceStatus>> {
    return axios.get<DeviceStatus>(this.baseURL + '/v1/devices/' + id,
      {headers: this.headers()});
  }

  setTemperatureFahrenheit(id: string, temperature: number): Promise<ClientResponse<Control>> {
    return axios.patch<Control>(this.baseURL + '/v1/devices/' + id, {set_temperature_f: temperature},
      {headers: this.headers()});
  }

  setTemperatureCelsius(id: string, temperature: number): Promise<ClientResponse<Control>> {
    return axios.patch<Control>(this.baseURL + '/v1/devices/' + id, {set_temperature_c: temperature},
      {headers: this.headers()});
  }

  setThermalControlStatus(id: string, targetState: 'standby' | 'active'): Promise<ClientResponse<Control>> {
    return axios.patch<Control>(this.baseURL + '/v1/devices/' + id, {thermal_control_status: targetState},
      {headers: this.headers()});
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

