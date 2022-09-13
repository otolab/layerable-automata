# layerable-automata


```
import { promisify } from 'util';
import { Automata, State } from "./index";

const wait = promisify(setTimeout);

class Cargo {
  flag: boolean | null = false;
}

const automata = new Automata(Cargo);

automata.registerSystem('main', {
  '@start': new State((_event, _cargo) => {
    console.log('main@start');
    return 'state1'
  }),

  'state1': new State((event, cargo) => {
    if (!automata.isRecentSystem('main')) return;
    console.log('main@state1');
    const { type, name } = event;
    if ( type == 'automata' && name == 'leaved' ) {
      cargo.flag = true;
      return 'state2';
    }
    return '#sub'
  }),

  'state2': new State((_event, _cargo) => {
    console.log('main@state2');
    return '@end'
  }),
});

automata.registerSystem('sub', {
  '@start': new State((_event, _cargo) => {
    console.log('sub@start');
    return 'sub-state'
  }),

  'sub-state': new State(async (_event, _cargo) => {
    console.log('sub@sub-state');
    await wait(100);
    return '@end'
  }),

  '@end': new State(() => {
    console.log('sub@end');
    automata.pushMessage({ type: 'automata', name: 'leaved', data: {} });
  }),

});

automata.pushContext('main');

automata.start();

automata.pushMessage();
automata.pushMessage();

setTimeout(() => {
  automata.pushMessage();
}, 1000);
```