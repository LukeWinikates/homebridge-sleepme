// noinspection HttpUrlsUsage

import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {Control, Device, DeviceStatus} from '../sleepme/client';
import * as crypto from 'node:crypto';

const devices: Device[] = [{
  attachments: [],
  name: 'Device 1',
  id: '12345678987654321',
}];

interface RespondWith {
  success:()=>void;
  error429:()=>void;
  error500:()=>void;
}

interface DeviceGetRequests {
  length: number,
  respondWith: RespondWith,
}

export type FakeServer = {
  host: string;
  stop: () => Promise<string>;
  waitForARequest: (count?:number) => Promise<void>;
  token: string;
  requests: Record<string, number>
  deviceGetRequests: DeviceGetRequests
  devicePatchRequests: { req: IncomingMessage, res: ServerResponse }[]
};

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

export function sendDeviceResponse(res: ServerResponse<IncomingMessage>) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(fakeDevice()));
}

export function handleControlRequest({res, req}: { res: ServerResponse, req: IncomingMessage }) {
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
}

export function start(): FakeServer {
  const hostname = '127.0.0.1';
  const port = Math.floor(Math.random() * 1000) + 12000;
  const token = crypto.randomBytes(20).toString('hex');

  const requestCounts: Record<string, number> = {};
  const deviceGetRequests: { req: IncomingMessage, res: ServerResponse }[] = [];
  const devicePatchRequests: { req: IncomingMessage, res: ServerResponse }[] = [];

  const server = createServer((req, res) => {
    if (req.url) {
      requestCounts[req.url] = (requestCounts[req.url] ?? 0) + 1;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      deviceGetRequests.push({req, res});
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
      if (req.method === 'GET') {
        deviceGetRequests.push({req, res});
        return;
      }
      if (req.method === 'PATCH') {
        devicePatchRequests.push({req, res});
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
    requests: requestCounts,
    deviceGetRequests: {
      get length() {
        return deviceGetRequests.length;
      },
      respondWith:{
        success: () => {
          const res = deviceGetRequests[0].res;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(fakeDevice()));
        },
        error429:() =>{
          const res = deviceGetRequests[0].res;
          res.statusCode = 429;
          res.end();
        },
        error500:() => {
          const res = deviceGetRequests[0].res;
          res.statusCode = 500;
          res.end();
        },
      },
    },
    devicePatchRequests: devicePatchRequests,
    waitForARequest: (count: number = 1) => {
      return new Promise((resolve) => {
        const timeout = setInterval(() => {
          if (deviceGetRequests.length + devicePatchRequests.length >= count) {
            clearTimeout(timeout);
            resolve();
          }
        }, 10);
      });
    },
  };
}
