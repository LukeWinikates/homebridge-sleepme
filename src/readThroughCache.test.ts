import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {FakeServer, start} from './fakeserver/server';
import {Client} from './sleepme/client';
import ReadThroughCache from './readThroughCache';
import {Logger} from 'homebridge/lib/logger';

jest.mock('homebridge/lib/logger');

describe('ReadThroughCache', () => {
  let server: FakeServer;

  afterEach(async () => {
    await server.stop();
  });

  test('deduplicates in-flight requests', async () => {
    server = start();
    const client = new Client(server.token, server.host);
    const logger = new Logger();
    const readThroughCache = new ReadThroughCache(client, '1', logger);
    const requests = [
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get()];
    await server.waitForARequest();

    expect(server.deviceGetRequests.length).toEqual(1);
    server.deviceGetRequests.respondWith.success();
    await Promise.all(requests);

    expect(server.requests['/v1/devices/1']).toEqual(1);
  });

  describe('when a request was recently completed', () => {
    test('re-uses recently completed requests', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const logger = new Logger();
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.success();
      await request;
      expect(server.requests['/v1/devices/1']).toEqual(1);

      const secondRequest = readThroughCache.get();
      await secondRequest;
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });

  describe('when the server returns 429', () => {
    test('does not crash', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const logger = new Logger();
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.error429();
      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });

  describe('when the server returns 500', () => {
    test('does not crash', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const logger = new Logger();
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.error500();
      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });

  describe('when the token is invalid', () => {
    test('does not crash', async () => {
      server = start();
      const client = new Client('abc', server.host);
      const logger = new Logger();
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();

      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });
});
