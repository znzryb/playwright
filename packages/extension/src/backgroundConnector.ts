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

import { authenticate, bridgeTiming, retryDelay } from './backgroundProtocol';
import { openRelayConnection } from './pendingConnection';
import type { RelayConnection } from './relayConnection';

type Session = { id: string, url: string, key: string, clientName: string };
const alarmName = 'znzryb-background-bridge';

export class BackgroundConnector {
  private _socket?: WebSocket;
  private _key?: string;
  private _port = 8765;
  private _attempt = 0;
  private _startedAt = 0;
  private _lastPong = 0;
  private _ready = false;
  private _retryAt = 0;
  private _retry?: ReturnType<typeof setTimeout>;
  private _heartbeat?: ReturnType<typeof setInterval>;
  private _sessions = new Map<string, Promise<RelayConnection>>();
  status = 'Waiting for pairing';

  constructor(private _onSession: (connection: RelayConnection, clientName: string) => Promise<void>) {
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) this._check(); });
    chrome.runtime.onStartup.addListener(() => { void this._configure(); });
    chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void this._configure(); });
    globalThis.addEventListener('online', () => { if (!this._ready) this._restart(); });
    void chrome.alarms.create(alarmName, { periodInMinutes: bridgeTiming.alarm / 60000 });
    void this._configure();
  }

  private async _configure(): Promise<void> {
    const settings = await chrome.storage.local.get(['auth-token', 'bridge-port']);
    const key = settings['auth-token'];
    const port = settings['bridge-port'] ?? 8765;
    if (typeof key !== 'string' || !key) {
      this.status = 'Open extension settings once to pair'; return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.status = 'Invalid bridge port'; return;
    }
    if (this._key === key && this._port === port && this._socket)
      return;
    const changed = this._key !== key || this._port !== port;
    this._key = key;
    this._port = port;
    if (changed) {
      for (const session of this._sessions.values())
        void session.then(connection => connection.close('Pairing settings changed')).catch(() => {});
      this._sessions.clear();
    }
    this._restart();
  }

  private _restart(): void {
    clearTimeout(this._retry);
    this._retry = undefined;
    this._retryAt = 0;
    this._disconnect();
    this._connect();
  }

  private _disconnect(): void {
    const old = this._socket;
    this._socket = undefined;
    this._ready = false;
    clearInterval(this._heartbeat);
    old?.close();
  }

  private _connect(): void {
    if (!this._key || this._socket)
      return;
    this.status = 'Connecting';
    const socket = this._socket = new WebSocket('ws://127.0.0.1:' + this._port + '/bridge');
    this._startedAt = Date.now();
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', event => {
      if (this._socket !== socket)
        return;
      this._socket = undefined;
      this._ready = false;
      clearInterval(this._heartbeat);
      this.status = event.code === 1008 ? 'Pairing failed' : 'Disconnected; retrying';
      this._schedule(event.code === 4003 ? bridgeTiming.timeoutRetry : retryDelay(++this._attempt));
    });
    const pendingMessages: any[] = [];
    const handleMessage = (message: any) => {
      try {
        if (message.type === 'pong')
          this._lastPong = Date.now();
        else if (message.type === 'session')
          void this._session(message.session);
        else if (message.type === 'remove') {
          const session = this._sessions.get(message.id);
          this._sessions.delete(message.id);
          void session?.then(connection => connection.close('MCP disconnected')).catch(() => {});
        }
      } catch { socket.close(1008, 'Invalid bridge message'); }
    };
    socket.addEventListener('message', event => {
      if (this._socket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (!['session', 'remove', 'pong'].includes(message.type)) return;
        if (this._ready) handleMessage(message);
        else if (pendingMessages.length < 1000) pendingMessages.push(message);
        else socket.close(1008, 'Too many pending messages');
      } catch { socket.close(1008, 'Invalid bridge message'); }
    });
    void authenticate(socket, this._key, 'extension').then(() => {
      if (this._socket !== socket)
        return;
      this._ready = true;
      this._attempt = 0;
      this._lastPong = Date.now();
      this.status = 'Connected';
      for (const message of pendingMessages) handleMessage(message);
      pendingMessages.length = 0;
      this._heartbeat = setInterval(() => this._ping(), bridgeTiming.heartbeat);
    }).catch(() => { if (this._socket === socket) socket.close(1008, 'Authentication failed'); });
  }

  private _schedule(delay: number): void {
    clearTimeout(this._retry);
    this._retryAt = Date.now() + delay;
    this._retry = setTimeout(() => { this._retry = undefined; this._retryAt = 0; this._connect(); }, delay);
  }

  private _ping(): void {
    if (this._ready && this._socket?.readyState === WebSocket.OPEN)
      this._socket.send(JSON.stringify({ type: 'ping' }));
  }

  private _check(): void {
    if (this._socket && !this._ready && Date.now() - this._startedAt > bridgeTiming.connectTimeout) {
      this._socket.close(4003, 'connect-timeout'); return;
    }
    if (this._ready && Date.now() - this._lastPong > bridgeTiming.pongTimeout) {
      this._socket?.close(4001, 'pong-timeout'); return;
    }
    if (!this._socket && Date.now() >= this._retryAt)
      this._connect();
    this._ping();
  }

  private async _session(session: Session): Promise<void> {
    if (this._sessions.has(session.id))
      return;
    try {
      const url = new URL(session.url);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/extension/') ||
          url.search || url.hash || typeof session.key !== 'string' || !/^[a-f0-9]{64}$/.test(session.key))
        throw new Error('Invalid relay');
      const pending = openRelayConnection(url.href, session.key);
      this._sessions.set(session.id, pending);
      const connection = await pending;
      if (this._sessions.get(session.id) !== pending) { connection.close('Session removed'); return; }
      const cleanup = () => { if (this._sessions.get(session.id) === pending) this._sessions.delete(session.id); };
      // The tab-group callback installs its own onclose; preserve both callbacks.
      await this._onSession(connection, session.clientName);
      const onclose = connection.onclose;
      connection.onclose = reason => { cleanup(); onclose?.(reason); };
    } catch {
      this._sessions.delete(session.id);
      this.status = 'Relay connection failed';
    }
  }
}
