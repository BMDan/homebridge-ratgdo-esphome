import { API } from 'homebridge';
import { GarageDoor, initESPHome } from './garage-door';
import { withPrefix } from 'homebridge/lib/logger';

export default function(api: API) {
  api.registerAccessory('homebridge-ratgdo-esphome', 'GarageDoor', GarageDoor);
}

function run() {
  const source = initESPHome('192.168.0.50', 80, withPrefix('ESPHome'), e => console.log(e));
  return new Promise<void>(resolve => {
    process.stdin.on('keypress', async (str, key) => {
      if (key.ctrl && key.name === 'c') {
        source.close();
        resolve();
      }
    });
  });
}
/*
run()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch(() => {
    console.log('Exiting...');
    process.exit(1);
  });
*/
