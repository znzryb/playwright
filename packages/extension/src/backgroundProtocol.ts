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

export const bridgeTiming = {
  heartbeat: 20000, alarm: 30000, retryInitial: 2000, retryMultiplier: 1.5,
  retryMax: 300000, connectTimeout: 30000, timeoutRetry: 5000, pongTimeout: 90000,
};

export function retryDelay(attempt: number, random = Math.random()): number {
  const base = Math.min(bridgeTiming.retryInitial * Math.pow(bridgeTiming.retryMultiplier, attempt - 1), bridgeTiming.retryMax);
  return Math.min(Math.round(base * (0.8 + 0.4 * random)), bridgeTiming.retryMax);
}

async function hmac(key: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', imported, encoder.encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function authenticate(socket: WebSocket, key: string, role: 'extension' | 'relay'): Promise<void> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  await new Promise<void>((resolve, reject) => {
    let challenge: string | undefined;
    let receivedChallenge = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOpen = () => { timer = setTimeout(fail, 10000); };
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener('open', onOpen); socket.removeEventListener('message', onMessage); socket.removeEventListener('close', fail); socket.removeEventListener('error', fail); };
    const fail = () => { cleanup(); socket.close(); reject(new Error('Background bridge authentication failed')); };
    socket.addEventListener('open', onOpen);
    if (socket.readyState === WebSocket.OPEN) onOpen();
    const onMessage = async (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'challenge' && !receivedChallenge && typeof message.nonce === 'string' && /^[a-f0-9]{64}$/.test(message.nonce)) {
          receivedChallenge = true;
          challenge = message.nonce;
          const signature = await hmac(key, role + '\n' + challenge + '\n' + nonce);
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ role, nonce, proof: signature }));
        } else if (message.type === 'ready' && challenge) {
          const expected = await hmac(key, 'server\n' + role + '\n' + challenge + '\n' + nonce);
          if (message.proof !== expected) { fail(); return; }
          cleanup(); resolve();
        } else { fail(); }
      } catch { fail(); }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', fail);
    socket.addEventListener('error', fail);
  });
}
