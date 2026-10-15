/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import vm from 'vm';
import { buildSync } from 'esbuild';
import { test, expect } from './extension-fixtures';

function loadModule(file: string, globals: Record<string, any> = {}) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '../../packages/extension/src/' + file)], bundle: true, platform: 'browser', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, console, URL, TextEncoder, Uint8Array, crypto, ...globals });
  return module.exports;
}

test('Claude timing constants, backoff growth, jitter and cap', () => {
  const { bridgeTiming, retryDelay } = loadModule('backgroundProtocol.ts');
  expect({ ...bridgeTiming }).toEqual({ heartbeat: 20000, alarm: 30000, retryInitial: 2000, retryMultiplier: 1.5, retryMax: 300000, connectTimeout: 30000, timeoutRetry: 5000, pongTimeout: 90000 });
  expect([1, 2, 3].map(attempt => retryDelay(attempt, 0.5))).toEqual([2000, 3000, 4500]);
  expect(retryDelay(1, 0)).toBe(1600);
  expect(retryDelay(1, 1)).toBe(2400);
  expect(retryDelay(100, 0)).toBe(240000);
  expect(retryDelay(100, 1)).toBe(300000);
});

test('controlled clock covers connect watchdog, timeout retry and stale pong', async () => {
  let now = 100000;
  let sequence = 0;
  const tasks = new Map<number, { at: number, callback: () => void }>();
  const alarms: any[] = [];
  const listeners: any[] = [];
  class ClockDate extends Date { static now() { return now; } }
  class Socket {
    static OPEN = 1;
    readyState = 0;
    listeners = new Map<string, Set<Function>>();
    messages: any[] = [];
    closed?: number;
    constructor(public url: string) {}
    addEventListener(name: string, callback: Function) { const set = this.listeners.get(name) ?? new Set(); set.add(callback); this.listeners.set(name, set); }
    removeEventListener(name: string, callback: Function) { this.listeners.get(name)?.delete(callback); }
    close(code = 1000) { if (this.closed) return; this.closed = code; this.readyState = 3; for (const listener of [...this.listeners.get('close') ?? []]) listener({ code }); }
    send(text: string) { this.messages.push(JSON.parse(text)); }
  }
  const schedule = (callback: () => void, delay: number) => { const id = ++sequence; tasks.set(id, { at: now + delay, callback }); return id; };
  const { BackgroundConnector } = loadModule('backgroundConnector.ts', {
    Date: ClockDate, WebSocket: Socket, Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    setTimeout: schedule, clearTimeout: (id: number) => tasks.delete(id), setInterval: schedule, clearInterval: (id: number) => tasks.delete(id),
    addEventListener: () => {},
    chrome: {
      alarms: { onAlarm: { addListener: (fn: Function) => listeners.push(fn) }, create: (...args: any[]) => alarms.push(args) },
      runtime: { onStartup: { addListener() {} } },
      storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } },
    },
  });
  const connector = new BackgroundConnector(async () => {});
  await Promise.resolve();
  expect(alarms[0][1].periodInMinutes).toBe(0.5);
  connector._key = 'unit-test-key';
  connector._connect();
  const first = connector._socket;
  expect(first.url).toBe('ws://127.0.0.1:8765/bridge');
  connector._connect();
  expect(connector._socket).toBe(first);
  now += 30000;
  listeners[0]({ name: 'znzryb-background-bridge' });
  expect(first.closed).toBeUndefined();
  now++;
  listeners[0]({ name: 'znzryb-background-bridge' });
  expect(first.closed).toBe(4003);
  expect(connector._retryAt).toBe(now + 5000);
  now += 4999;
  expect(connector._socket).toBeUndefined();
  now++;
  const retry = [...tasks.values()].find(task => task.at === now)!;
  retry.callback();
  const second = connector._socket;
  expect(second).not.toBe(first);
  connector._ready = true;
  second.readyState = Socket.OPEN;
  connector._lastPong = now;
  connector._ping();
  expect(second.messages).toEqual([{ type: 'ping' }]);
  now += 90001;
  listeners[0]({ name: 'znzryb-background-bridge' });
  expect(second.closed).toBe(4001);
  expect(connector._retryAt).toBe(now + 2000);
  connector._disconnect();
});
