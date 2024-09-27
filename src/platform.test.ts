import {describe, expect, test, jest} from '@jest/globals';
import {PluginConfig, SleepmePlatform} from "./platform";
import {HomebridgeAPI} from "homebridge/lib/api";
import {Logger} from "homebridge/lib/logger";
import EventEmitter from "events";

function createPluginForTest(config: unknown): SleepmePlatform {
  const api = new HomebridgeAPI()
  const logger = Logger.withPrefix("test")
  jest.spyOn(logger, "error").mockImplementation(() => {
  });
  return new SleepmePlatform(logger, config as PluginConfig, api);
}

describe('platform', () => {
  describe("startup", () => {
    test('with no api_keys', () => {
      const platform = createPluginForTest({platform: "SleepmeHomebridgePlugin"});
      (platform.api as unknown as EventEmitter).emit("didFinishLaunching");
      expect(platform.log.error).toHaveBeenCalledWith("No API keys configured - plugin will not start")
    })
    test('with non-array api_keys', () => {
      const platform = createPluginForTest({platform: "SleepmeHomebridgePlugin", api_keys: {a: "b"}});
      (platform.api as unknown as EventEmitter).emit("didFinishLaunching");
      expect(platform.log.error).toHaveBeenCalledWith("No API keys configured - plugin will not start")
    })
  })
});
