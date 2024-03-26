import EventSource from 'eventsource';
import Timeout = NodeJS.Timeout;
import { RECONNECT_TIMEOUT } from './settings';

interface RatGDOPingEvent {
  title: string;
  comment: string;
  ota: boolean;
  log: boolean;
  lang: string;
}

//type RatGDOInitCallback = ({Model: string, SerialNumber: string}) => void;
export type RatGDOInitCallback = (unknown, Model: string, SerialNumber: string) => void;

export class ESPHomeDiscovery {
  private host: string;
  private port: number;
  private callback: RatGDOInitCallback;
  private readonly logger;
  private eventSource: EventSource;
  private initialized: boolean | null;
  private aliveTimeout: Timeout | null;

  constructor(private readonly configDevice, callback: RatGDOInitCallback, logger) {
    this.initialized = false;
    this.host = configDevice.host;
    this.port = configDevice.port;
    this.callback = callback;
    this.aliveTimeout = null as unknown as Timeout;
    this.logger = logger;
    this.initConnection();
  }

  private async initConnection(): Promise<EventSource> {
    try {
      this.eventSource = await this.connectToESPSource();
    } catch (e) {
      this.logger.error('[init] Failed to connect to ESPHome Source:', e);
      this.eventSource = null;
      setTimeout(() => {
        this.initConnection();
      }, RECONNECT_TIMEOUT);
      return null;
    }
  }

  private createTimeout(): Timeout | null {
    if (this.initialized === null) {
      return null;
    }
    return setTimeout(async () => {
      if (this.initialized === null) {
        this.logger.debug('[init] No new timeouts needed; setup work has been completed.');
        return null;
      }

      this.logger.debug('[init] Timeout is closing connection...');
      this.closeConnection();
      this.logger.info('[init] Timeout has closed connection; reopening...');
      await this.initConnection();
      this.logger.debug('[init] Timeout has reopened connection.');
    }, 20 * 1000); // if no ping is received in 20 seconds, we reconnect
  }

  private closeConnection() {
    this.closeConnection2(this.eventSource);
  }

  // The ping event happens so quickly that the `await` that will populate
  // this.eventsource often hasn't finished yet, so we cheat and just pass
  // it in directly from the ping handler.  The timeout handler, on the
  // other hand, is well-behaved, so it sources from `this.`.
  private closeConnection2(eventSource: EventSource) {
    this.logger.debug('[init] Closing connection...');
    try {
      if (!eventSource) {
        this.logger.debug('[init] No event source to close.');
      } else {
        eventSource.close();
        this.logger.debug('[init] Connection closed.');
      }
    } catch (e) {
      this.logger.warn('[init] Unable to cleanly close init listener:', e);
    } finally {
      if (this.initialized) { // Don't overwrite null.
        this.initialized = false;
      }
    }
    this.logger.debug('[init] Close attempt completed.');
  }

  private connectToESPSource(): Promise<EventSource> {
    return new Promise((resolve, reject) => {
      try {
        const url = `http://${this.host}:${this.port}/events`;
        const eventSource = new EventSource(url);

        eventSource.onerror = async e => {
          this.logger.warn('[init] Connection error, reinitializing...', e);
          this.initialized = false;
          reject(e);
        };
        eventSource.onopen = m => {
          if (!this.initialized) {
            this.logger.info(`[init] Connection to ESP initialized: Event source started at ${url}: ${m}`);
            this.initialized = true;
            if ( this.aliveTimeout !== null ) {
              clearTimeout(this.aliveTimeout);
            }
            this.aliveTimeout = this.createTimeout();
            eventSource.addEventListener('ping', ev => {
              if ( ev.data === '' ) {
                this.logger.warn('[init] Skipping empty ping:', ev);
              } else {
                try {
                  const b = JSON.parse(ev.data) as RatGDOPingEvent;
                  this.logger.info('[init] Publishing accessory with model data:', b.title);
                  this.callback(
                    this.configDevice,
                    b.title.split(' ')[0], // Model
                    b.title.split(' ')[1], // Serial #
                  );
                  this.logger.debug('[init] Callback called; shutting down this listener.');
                  this.initialized = null;
                  this.closeConnection2(eventSource);
                  if ( this.aliveTimeout !== null ) {
                    clearTimeout(this.aliveTimeout);
                  }
                } catch (e) {
                  this.logger.debug('[init] Got event:', ev);
                  this.logger.debug('[init] Got event data:', ev.data);
                  this.logger.error('[init] Cannot parse RatGDOPingEvent', e);
                }
              }
            });
            resolve(eventSource);
          }
        };
      } catch (e) {
        this.logger.error('[init] ConnectToESPSource got error:', e);
        reject(e);
      }
    });
  }
}
