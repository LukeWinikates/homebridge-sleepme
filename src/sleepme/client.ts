import axios from 'axios';

class Client {
  readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  headers(): object {
    return {
      'Authorization': `Bearer ${this.token}`,
    };
  }

  listDevices(): Promise<axios.AxiosResponse<Device[]>> {
    return axios.get<Device[]>('https://api.developer.sleep.me/v1/devices',
      {headers: this.headers()});
  }

  getDeviceStatus(id: string): Promise<axios.AxiosResponse<DeviceStatus>> {
    return axios.get<DeviceStatus>('https://api.developer.sleep.me/v1/devices/' + id,
      {headers: this.headers()});
  }
}

type Device = {
  id: string;
  name: string;
  attachments: string[];
};

type DeviceStatus = {
  about: {
    firmware_version: string;
    ip_address: string;
    lan_address: string;
    mac_address: string;
    model: string;
    serial_number: string;
  };
  control: {
    brightness_level: number;
    display_temperature_unit: string;
    set_temperature_c: number;
    set_temperature_f: number;
    thermal_control_status: string;
    time_zone: string;
  };
  status: {
    is_connected: boolean;
    is_water_low: boolean;
    water_level: number;
    water_temperature_f: number;
    water_temperature_c: number;
  };
};

