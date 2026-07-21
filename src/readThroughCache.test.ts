import {describe, test, expect, beforeEach,afterEach, vi} from 'vitest';
import {FakeServer, start} from './fakeserver/server';
import {Client} from './sleepme/client';
import ReadThroughCache from './readThroughCache';
import {Logger, Logging} from 'homebridge';


describe('ReadThroughCache', () => {
  let server: FakeServer;
  let logger: Logging;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logging;
  });
  afterEach(async () => {
    await server.stop();
  });

  test('deduplicates in-flight requests', async () => {
    server = start();
    const client = new Client(server.token, server.host);
    const readThroughCache = new ReadThroughCache(client, '1', logger);
    const requests = [
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get(),
      readThroughCache.get()];
    await server.waitForARequest();

    expect(server.deviceGetRequests.length).toEqual(1);
    server.deviceGetRequests.respondWith.success(0);
    await Promise.all(requests);

    expect(server.requests['/v1/devices/1']).toEqual(1);
  });

  describe('when a request was recently completed', () => {
    test('re-uses recently completed requests', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.success(0);
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
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.error429(0);
      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });

  describe('when the server returns 500', () => {
    test('does not crash', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      server.deviceGetRequests.respondWith.error500(0);
      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });

    test('another request can go through later', async () => {
      server = start();
      const client = new Client(server.token, server.host);
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();
      await server.waitForARequest();

      const startTime = new Date();

      server.deviceGetRequests.respondWith.error500(0);
      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);

      const number = startTime.valueOf() + 5000000;
      vi.spyOn(Date, 'now').mockImplementation(() => number);
      const request2 = readThroughCache.get();
      await server.waitForARequest(2);

      server.deviceGetRequests.respondWith.error500(1);
      await expect(request2).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(2);
    });
  });

  describe('when the token is invalid', () => {
    test('does not crash', async () => {
      server = start();
      const client = new Client('abc', server.host);
      const readThroughCache = new ReadThroughCache(client, '1', logger);
      const request = readThroughCache.get();

      await expect(request).resolves.toBe(null);
      expect(server.requests['/v1/devices/1']).toEqual(1);
    });
  });
});
