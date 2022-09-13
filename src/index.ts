import { promisify } from 'util';

const wait = promisify(setTimeout);

export type StateHandler<Cargo> = (
  event: Event,
  cargo: Cargo
) => Promise<string | undefined | void> | string | undefined | void;

export type OnTransitionHandler<Cargo> = (to: string, from: string, cargo: Cargo) => void;

interface StateOptions<Cargo> {
  onTransition?: OnTransitionHandler<Cargo>;
}

export class State<Cargo> {
  handler: StateHandler<Cargo>;
  onTransitionHandler: OnTransitionHandler<Cargo> | undefined;

  constructor(handler: StateHandler<Cargo>, options?: StateOptions<Cargo>) {
    this.handler = handler;
    const { onTransition }: StateOptions<Cargo> = options || {};

    this.onTransitionHandler = onTransition;
  }

  async run(event: Event, cargo: any) {
    return this.handler(event, cargo);
  }
}

type UpdateContextsHandler = () => void;

interface Context<Cargo> {
  system: string;
  currentState: string;
  cargo: Cargo;
}

interface System<Cargo> {
  [key: string]: State<Cargo>;
}

interface Event {
  type?: string;
  name?: string;
  data?: any;
}

export class Automata<Cargo> {
  systems: { [key: string]: System<Cargo> } = {};
  contexts: Context<Cargo>[] = [];
  events: Event[] = [];
  onUpdateContexts: UpdateContextsHandler | null = null;
  _eventIter: AsyncGenerator<Event, void, unknown>;
  debug: boolean = false;
  latestTransition: number;
  CargoClass: { new (): Cargo };

  constructor(CargoClass: { new (): Cargo }) {
    const { events } = this;

    this.CargoClass = CargoClass;

    // イベントの取得。このへんstreamで実装してもいいのかもな..
    async function* gen(time: number) {
      // イベントの発生がもうない場合にはfunctionを終了し、done: trueを返すことができる
      // Automataの外部からeventが供給されうるので、終了は判断できないか?
      while (true) {
        // FIFOなのでshift
        const event = events.shift();
        if (event) {
          yield event;
        }
        await new Promise((resolve) => setTimeout(resolve, time));
      }
    }
    this._eventIter = gen(30);
    this.latestTransition = Date.now();
  }

  getCargoStack(): Array<Cargo> {
    return this.contexts.map((context) => context.cargo);
  }

  _onUpdateContexts() {
    if (!this.onUpdateContexts) return;
    this.onUpdateContexts();
  }

  pushEvent(event?: Event) {
    this.events.push(event || {});
  }

  registerSystem(name: string, system: System<Cargo>) {
    this.systems[name] = system;
  }

  getContext(systemName: string) {
    return this.contexts.find((context) => context.system == systemName);
  }

  isRecentSystem(systemName: string): boolean {
    return systemName === this.contexts[this.contexts.length - 1]?.system;
  }

  pushContext(systemName: string) {
    const context = {
      system: systemName,
      currentState: '@start',
      cargo: new this.CargoClass(),
    };
    this.contexts.push(context);

    const onTransition = this.systems[systemName]['@start'].onTransitionHandler;
    if (onTransition) {
      onTransition(systemName, '@start', context.cargo);
    }

    this._onUpdateContexts();

    this.log(`initialize: ${systemName}`);
    this.pushEvent({ type: 'automata', name: 'entered', data: { systemName } });
  }

  async _finalizeContext(context: Context<Cargo>) {
    const { cargo, system } = context;
    const finalizeState = this.systems[system]['@finalize'];
    if (finalizeState) {
      const finializeEvent = {
        type: 'automata',
        name: 'finalize',
        data: { context },
      };
      this.log(`finalize: ${system}`);
      await finalizeState.run(finializeEvent, cargo);
    }
  }

  async _removeDescendants(context: Context<Cargo>, withSelf = false) {
    const idx = this.contexts.findIndex((c) => c === context);
    const newContexts = this.contexts.slice(0, idx + (withSelf ? 0 : 1));

    // 削除するほうはfinalize
    await Promise.all(
      this.contexts.slice(idx + (withSelf ? 0 : 1)).map(async (context) => {
        await this._finalizeContext(context);
        this.log(`trash: ${context.system}`);
      })
    );

    this.contexts = newContexts;
  }

  log(msg: string) {
    if (this.debug) {
      console.log('automata:', msg);
    }
  }

  async _transitionTo(stateName: string, context: Context<Cargo>) {
    // 終了stateへの遷移
    if (stateName === '@end') {
      // 明示的な終了を表すイベントとして@end stateを実行
      const endState = this.systems[context.system]['@end'];
      if (endState) {
        const finializeEvent = {
          type: 'automata',
          name: 'end',
          data: { context },
        };
        this.log(`end: ${context.system}`);
        await endState.run(finializeEvent, context.cargo);
      }

      // 自身をcontextsから削除
      const self = this.contexts.pop();
      if (!self) return false;
      await this._finalizeContext(self);

      this._onUpdateContexts();

      this.log(`leave: ${self.system}`);
      return true;
    }

    // それ自体への再遷移
    else if (stateName === '@current') {
      // 子孫contextがある場合は削除
      await this._removeDescendants(context);

      const onTransition = this.systems[context.system][context.currentState].onTransitionHandler;
      if (onTransition) {
        onTransition(context.currentState, context.currentState, context.cargo);
      }

      this._onUpdateContexts();

      this.log(`re-transition: ${context.system}`);
    }

    // 同じstateに対する遷移は無効（明示的に@currentを使う）
    else if (stateName == context.currentState) {
      return false;
    }

    // 子の#<systemName>@startに遷移する
    else if (stateName.startsWith('#')) {
      let systemName = stateName.slice(1);
      const idx = this.contexts.findIndex((c) => c === context);

      // #@currentへの遷移
      if (systemName == '@current') {
        systemName = context.system;
      }

      // 子のcontextが指定されたものと同じ場合無視
      else if (this.contexts[idx + 1] && systemName === this.contexts[idx + 1].system) {
        return false;
      }

      // 現在のコンテクストの子孫contextを削除
      await this._removeDescendants(context);

      // 新しく指定のsystemのcontextを作成
      this.pushContext(systemName);

      this.log(`enter(${context.system}): => #${systemName}`);
    }

    // 通常の遷移
    else {
      // 子孫contextがある場合は削除
      await this._removeDescendants(context);

      const onTransition = this.systems[context.system][stateName].onTransitionHandler;
      if (onTransition) {
        onTransition(stateName, context.currentState, context.cargo);
      }

      this.log(`transition(${context.system}): ${context.currentState} => ${stateName}`);

      context.currentState = stateName;
    }

    // watch対象の更新
    this._onUpdateContexts();

    return true;
  }

  async do() {
    const { value: event } = await this._eventIter.next();
    if (!event) return this.contexts.length > 0;

    for (const context of this.contexts) {
      const { system, currentState, cargo } = context;
      const state = this.systems[system][currentState];

      // 遷移イベントは発生したcontextのみに発生している
      if (event.type == 'automata' && event.name == 'transition' && event.data.systemName != context.system) {
        continue;
      }

      // stateの処理
      const nextStateName = await state.run(event, cargo);

      if (nextStateName) {
        // 遷移する
        const moved = await this._transitionTo(nextStateName, context);

        // 遷移が発生した場合は子孫contextsが破棄されるので、以降の処理はない
        if (moved) {
          this.latestTransition = Date.now();
          break;
        }
      } else {
        // 無視された場合は子孫contextに処理を譲る
      }
    }
    return this.contexts.length > 0;
  }

  async start(time = 100) {
    while (await this.do()) {
      await wait(time);
    }
  }
}
