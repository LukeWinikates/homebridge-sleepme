import axios, {AxiosResponse} from 'axios';

export class Client {
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  headers(): object {
    return {
      'Authorization': `Bearer ${this.token}`,
    };
  }

  listDevices(): Promise<AxiosResponse<Device[]>> {
    return axios.get<Device[]>('https://api.developer.sleep.me/v1/devices',
      {headers: this.headers()});
  }

  getDeviceStatus(id: string): Promise<AxiosResponse<DeviceStatus>> {
    return axios.get<DeviceStatus>('https://api.developer.sleep.me/v1/devices/' + id,
      {headers: this.headers()});
  }

  setTemperatureFahrenheit(id: string, temperature: number): Promise<AxiosResponse<Control>> {
    return axios.patch<Control>('https://api.developer.sleep.me/v1/devices/' + id, {set_temperature_f: temperature},
      {headers: this.headers()});
  }

  setTemperatureCelsius(id: string, temperature: number): Promise<AxiosResponse<Control>> {
    return axios.patch<Control>('https://api.developer.sleep.me/v1/devices/' + id, {set_temperature_c: temperature},
      {headers: this.headers()});
  }

  setThermalControlStatus(id: string, targetState: 'standby' | 'active') : Promise<AxiosResponse<Control>>{
    return axios.patch<Control>('https://api.developer.sleep.me/v1/devices/' + id, {thermal_control_status: targetState},
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

