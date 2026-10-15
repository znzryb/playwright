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

import http from 'http';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { playwrightExtensionId } from '../utils/extension';

const origin = 'chrome-extension://' + playwrightExtensionId;
const proof = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
const equal = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export type BackgroundSession = { id: string, url: string, key: string, clientName: string };

export function bridgePort(): number {
  const port = Number(process.env.PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT');
  return port;
}

export async function authenticateServer(socket: WebSocket, key: string, expectedRole?: string): Promise<string> {
  const challenge = randomBytes(32).toString('hex');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(), 10000);
    const fail = () => { cleanup(); socket.close(1008, 'Authentication failed'); reject(new Error('Background bridge authentication failed')); };
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', fail); socket.off('error', fail); };
    const onMessage = (data: any) => {
      try {
        const message = JSON.parse(data.toString());
        const { role, nonce } = message;
        if (!['extension', 'agent', 'relay'].includes(role) || (expectedRole && role !== expectedRole) ||
            typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) ||
            !equal(message.proof, proof(key, role + '\n' + challenge + '\n' + nonce)))
          return fail();
        cleanup();
        socket.send(JSON.stringify({ type: 'ready', proof: proof(key, 'server\n' + role + '\n' + challenge + '\n' + nonce) }));
        resolve(role);
      } catch { fail(); }
    };
    socket.on('message', onMessage);
    socket.once('close', fail);
    socket.once('error', fail);
    socket.send(JSON.stringify({ type: 'challenge', nonce: challenge }));
  });
}

async function authenticateClient(socket: WebSocket, key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const nonce = randomBytes(32).toString('hex');
    let challenge: string;
    const timer = setTimeout(() => fail(), 10000);
    const cleanup = () => { clearTimeout(timer); socket.off('message', onMessage); socket.off('error', fail); socket.off('close', fail); };
    const fail = () => { cleanup(); socket.close(); reject(new Error('Port is occupied or background bridge authentication failed')); };
    const onMessage = (data: any) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'challenge' && typeof message.nonce === 'string') {
          challenge = message.nonce;
          socket.send(JSON.stringify({ role: 'agent', nonce, proof: proof(key, 'agent\n' + challenge + '\n' + nonce) }));
        } else if (challenge && message.type === 'ready' && equal(message.proof, proof(key, 'server\nagent\n' + challenge + '\n' + nonce))) {
          cleanup(); resolve();
        } else { fail(); }
      } catch { fail(); }
    };
    socket.on('message', onMessage);
    socket.once('error', fail);
    socket.once('close', fail);
  });
}

// The first MCP process owns discovery. Every process, including the owner,
// registers through the same authenticated socket and can take over on exit.
export class BackgroundBridge {
  private _server?: http.Server;
  private _wss?: WebSocketServer;
  private _socket?: WebSocket;
  private _extensions = new Set<WebSocket>();
  private _sessions = new Map<WebSocket, BackgroundSession>();
  private _retry?: NodeJS.Timeout;
  private _closed = false;
  private _generation = 0;
  constructor(private _key: string, private _session: BackgroundSession, private _onError: (error: Error) => void) {}

  async start(): Promise<void> { await this._connect(); }

  private async _listen(): Promise<void> {
    if (this._server)
      return;
    const server = http.createServer((_req, response) => { response.writeHead(404); response.end(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bridgePort(), '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
    } catch (error: any) {
      server.close();
      if (error.code === 'EADDRINUSE')
        return;
      throw error;
    }
    this._server = server;
    const wss = this._wss = new WebSocketServer({ server, maxPayload: 65536, path: '/bridge' });
    wss.on('connection', (socket, request) => {
      const peerOrigin = request.headers.origin;
      if (peerOrigin && peerOrigin !== origin) {
        socket.close(1008, 'Invalid origin'); return;
      }
      void authenticateServer(socket, this._key, peerOrigin ? 'extension' : 'agent').then(role => {
        if (this._closed) { socket.close(); return; }
        if (role === 'extension') {
          this._extensions.add(socket);
          for (const session of this._sessions.values())
            socket.send(JSON.stringify({ type: 'session', session }));
        }
        socket.on('message', data => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'ping')
              socket.send(JSON.stringify({ type: 'pong' }));
            else if (role === 'agent' && message.type === 'register' && !this._sessions.has(socket)) {
              const session = message.session as BackgroundSession;
              const url = new URL(session.url);
              if (typeof session.id !== 'string' || typeof session.key !== 'string' || !/^[a-f0-9]{64}$/.test(session.key) ||
                  typeof session.clientName !== 'string' || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
                  !url.pathname.startsWith('/extension/') || url.search || url.hash)
                throw new Error('Invalid session');
              this._sessions.set(socket, session);
              this._broadcast({ type: 'session', session });
            }
          } catch { socket.close(1008, 'Invalid message'); }
        });
        socket.on('close', () => {
          this._extensions.delete(socket);
          const session = this._sessions.get(socket);
          this._sessions.delete(socket);
          if (session)
            this._broadcast({ type: 'remove', id: session.id });
        });
      }).catch(() => {});
      socket.on('error', () => {});
    });
  }

  private _broadcast(message: unknown): void {
    for (const socket of this._extensions) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    }
  }

  private async _connect(): Promise<void> {
    if (this._closed)
      return;
    await this._listen();
    const generation = ++this._generation;
    const socket = this._socket = new WebSocket('ws://127.0.0.1:' + bridgePort() + '/bridge', { maxPayload: 65536 });
    try {
      await authenticateClient(socket, this._key);
      if (this._closed || generation !== this._generation) { socket.close(); return; }
      socket.send(JSON.stringify({ type: 'register', session: this._session }));
      const heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 20000);
      socket.once('close', () => { clearInterval(heartbeat); this._scheduleReconnect(); });
    } catch (error: any) {
      if (!this._closed)
        this._onError(error);
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed || this._retry)
      return;
    this._retry = setTimeout(() => { this._retry = undefined; void this._connect().catch(this._onError); }, 2000);
  }

  close(): void {
    this._closed = true;
    clearTimeout(this._retry);
    this._socket?.close();
    for (const socket of this._wss?.clients ?? []) socket.close();
    this._wss?.close();
    this._server?.close();
  }
}
