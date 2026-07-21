import {describe, test, expect, afterEach, vi} from 'vitest';
import {PluginConfig, SleepmePlatform} from './platform';
import EventEmitter from 'events';
import {FakeServer, start} from './fakeserver/server';
import {PLUGIN_NAME} from './settings';
import type {API, Logging} from 'homebridge';

class FakeHomebridgeAPI extends EventEmitter {
  public hap = {};
  platformAccessory: () => void;

  constructor() {
    super();
    this.platformAccessory = vi.fn();
    this.hap = {
      uuid: {
        generate: (id: string) => id,
      },
    };
  }
}

function createPluginForTest(config: unknown): SleepmePlatform {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logging;

  const api = new FakeHomebridgeAPI() as unknown as API;
  return new SleepmePlatform(logger, config as PluginConfig, api as API);
}

describe('platform', () => {
  describe('startup', () => {
    test('with no api_keys', () => {
      const platform = createPluginForTest({platform: 'SleepmeHomebridgePlugin'});
      (platform.api as unknown as EventEmitter).emit('didFinishLaunching');
      expect(platform.log.error).toHaveBeenCalledWith('No API keys configured - plugin will not start');
    });

    test('with non-array api_keys', () => {
      const platform = createPluginForTest({platform: 'SleepmeHomebridgePlugin', api_keys: {a: 'b'}});
      (platform.api as unknown as EventEmitter).emit('didFinishLaunching');
      expect(platform.log.error).toHaveBeenCalledWith('No API keys configured - plugin will not start');
    });

    test('with empty array api_keys', () => {
      const platform = createPluginForTest({platform: 'SleepmeHomebridgePlugin', api_keys: {a: 'b'}});
      (platform.api as unknown as EventEmitter).emit('didFinishLaunching');
      expect(platform.log.error).toHaveBeenCalledWith('No API keys configured - plugin will not start');
    });

    describe('with invalid API key', () => {
      let server: FakeServer;

      afterEach(async () => {
        await server.stop();
      });

      test('does not start', async () => {
        server = start();
        const platform = createPluginForTest({
          platform: PLUGIN_NAME,
          api_keys: ['abc'],
          sleepme_api_url: server.host,
        });

        const discoverDevices = platform.discoverDevices();
        await server.waitForARequest();
        await discoverDevices;

        expect(platform.log.error).toHaveBeenCalledWith('the token ending in abc is invalid.');
        expect(platform.accessories.length).toBe(0);
      });
    });

    describe('with valid API key', () => {
      let server: FakeServer;

      afterEach(async () => {
        await server.stop();
      });

      test('registers accessories', async () => {
        server = start();
        const platform = createPluginForTest({
          platform: PLUGIN_NAME,
          api_keys: [server.token],
          sleepme_api_url: server.host,
        });

        const discoverDevices = platform.discoverDevices();
        await discoverDevices;
        expect(platform.api.platformAccessory).toHaveBeenCalled();
      });
    });
  });
});
