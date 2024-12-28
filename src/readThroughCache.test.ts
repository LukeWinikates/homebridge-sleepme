import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {FakeServer, start} from './fakeserver/server';
import {Client} from './sleepme/client';
import ReadThroughCache from './readThroughCache';
import {Logger} from 'homebridge/lib/logger';

jest.mock('homebridge/lib/logger');

describe('client', () => {
  let server: FakeServer;

  afterEach(async () => {
    await server.stop();
  });

  test('get deduplicates in-flight requests', async () => {
    server = start();
    const client = new Client(server.token, server.host);
    const logger = new Logger();

    const readThroughCache = new ReadThroughCache(client, '1', logger)
    await Promise.all([
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get()])

    expect(server.requests['/v1/devices/1']).toEqual(1);
  });

  test('get re-uses recently completed requests', async () => {
    server = start();
    const client = new Client(server.token, server.host);
    const logger = new Logger();
    const readThroughCache = new ReadThroughCache(client, '1', logger)
    const request = readThroughCache.get()
    await request
    expect(server.requests['/v1/devices/1']).toEqual(1);
    const secondRequest = readThroughCache.get();
    await secondRequest;
    expect(server.requests['/v1/devices/1']).toEqual(1);
  });
});
