import {Client, DeviceStatus, ClientResponse} from './sleepme/client';
import {Logger} from 'homebridge';

class ReadThroughCache {
  private value?: ClientResponse<DeviceStatus>;
  private request?: Promise<ClientResponse<DeviceStatus>>;
  private responseTimestamp?: Date
  private expirationMS = 1000;

  constructor(readonly client: Client, readonly deviceId: string, private readonly log: Logger) {
  }

  get(): Promise<ClientResponse<DeviceStatus>> {
    this.log.debug('get device status')
    if (this.value && this.responseTimestamp &&
      ((this.responseTimestamp.valueOf() + this.expirationMS) > new Date().valueOf())) {
      this.log.info(`returning previously fetched value from ${this.responseTimestamp}`)
      return Promise.resolve(this.value)
    }
    if (!this.request) {
      this.log.info('making new request')
      this.request = this.client.getDeviceStatus(this.deviceId)
      this.request.then(response => {
        this.log.info('request completed')
        this.log.info(`status: ${response.status}`)
        this.log.debug(`response: ${JSON.stringify(response.data, null, '  ')}`)
        this.value = response;
        this.responseTimestamp = new Date();
        this.request = undefined;
      });
    }
    this.log.debug('returning current in-flight request')
    return this.request;
  }
}

export default ReadThroughCache
