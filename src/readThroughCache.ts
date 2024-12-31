import {Client, DeviceStatus, ClientResponse} from './sleepme/client';
import {Logger} from 'homebridge';
import {AxiosError} from 'axios';

class ReadThroughCache {
  private value?: ClientResponse<DeviceStatus>;
  private request?: Promise<ClientResponse<DeviceStatus> | null>;
  private responseTimestamp?: Date;
  private responseExpireAt?: Date;
  private errorCount = 0;
  private expirationMS = 1000;

  constructor(readonly client: Client, readonly deviceId: string, private readonly log: Logger) {
  }

  get(): Promise<null | ClientResponse<DeviceStatus>> {
    this.log.debug(`get device status (responseTimestamp:${this.responseTimestamp}, responseExpireAt: ${this.responseExpireAt})`);
    if (this.value && this.responseExpireAt &&
      (new Date().valueOf() < this.responseExpireAt.valueOf())) {
      this.log.info(`returning previously fetched value from ${this.responseTimestamp}`);
      return Promise.resolve(this.value);
    }
    if (!this.request) {
      this.log.info('making new request');
      this.request = this.client.getDeviceStatus(this.deviceId).then(response => {
        this.log.info('request completed');
        this.log.info(`status: ${response.status}`);
        this.log.debug(`response: ${JSON.stringify(response.data, null, '  ')}`);
        this.value = response;
        this.responseTimestamp = new Date();
        this.responseExpireAt = new Date(this.responseTimestamp.valueOf() + this.expirationMS);
        this.request = undefined;
        this.errorCount = 0;
        return response;
      }).catch((err: Error | AxiosError) => {
        this.errorCount += 1;
        this.log.debug(`request error: ${err.message}`);
        if (this.value) {
          const backoffDuration = Math.max(Math.pow(2, this.errorCount) * this.expirationMS, 60 * 1000);
          this.responseExpireAt = new Date(new Date().valueOf() + backoffDuration);
          this.log.error(`backing off get requests until ${this.responseExpireAt}`);
          return this.value;
        }
        return null;
      });
    }
    this.log.debug('returning current in-flight request');
    return this.request;
  }
}

export default ReadThroughCache;
