// noinspection HttpUrlsUsage

import {createServer, IncomingMessage} from 'node:http';
import {Control, Device, DeviceStatus} from '../sleepme/client';
import * as crypto from 'node:crypto';

export type FakeServer = { host: string; stop: () => Promise<string>; token: string };

function fakeDevice(): DeviceStatus {
  return {
    about: {
      firmware_version: '5.38.2031',
      ip_address: '',
      lan_address: '',
      mac_address: '',
      model: 'DP999NA',
      serial_number: '2345823512345',
    },
    control: {
      brightness_level: 100,
      display_temperature_unit: 'f',
      set_temperature_c: 22,
      set_temperature_f: 72,
      thermal_control_status: 'standby',
      time_zone: 'America/Los_Angeles',
    },
    status: {
      is_connected: false,
      is_water_low: false,
      water_level: 100,
      water_temperature_f: 74,
      water_temperature_c: 23.5,
    },
  };
}

function parseBody(req: InstanceType<typeof IncomingMessage>): Promise<string> {
  let requestBody: string = '';
  // let changes = JSON.parse<Control>(req.);

  return new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      requestBody += chunk;
    });
    req.on('end', () => {
      resolve(requestBody);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function start(): FakeServer {
  const hostname = '127.0.0.1';
  const port = Math.floor(Math.random() * 1000) + 12000;
  const token = crypto.randomBytes(20).toString('hex');
  const devices: Device[] = [{
    attachments: [],
    name: 'Device 1',
    id: '1',
  }];
  const statuses: Record<string, DeviceStatus> = {
    '1': fakeDevice(),
  };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 403;
      res.end('unauthorized');
      return;
    }
    if (req.url === '/v1/devices') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(devices));
      return;
    }
    if (req.url?.startsWith('/v1/devices')) {
      const id = req.url?.replace('/v1/devices/', '');
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(statuses[id]));
        return;
      }
      if (req.method === 'PATCH') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        const controlResponse: Control = {
          brightness_level: 100,
          display_temperature_unit: 'f',
          set_temperature_c: 22,
          set_temperature_f: 72,
          thermal_control_status: 'standby',
          time_zone: 'America/Los_Angeles',
        };
        parseBody(req).then(requestBody => {
          const changes = JSON.parse(requestBody);
          res.statusCode = 200;
          res.end(JSON.stringify({
            ...controlResponse,
            ...changes,
          }));
        });
        return;
      }
    }

    res.statusCode = 404;
    res.end('');
  });

  server.listen(port, hostname, () => {

  });

  return {
    host: `http://${hostname}:${port}`,
    stop: () => {
      server.closeAllConnections();
      return new Promise((resolve) => {
        server.close(() => {
          resolve('closed');
        });
      });
    },
    token: token,
  };
}