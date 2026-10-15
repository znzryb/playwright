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

import React, { useCallback, useEffect, useState } from 'react';
import { CopyToClipboard } from './copyToClipboard';
import * as icons from './icons';
import './authToken.css';

export const AuthTokenSection: React.FC<{}> = ({}) => {
  const [authToken, setAuthToken] = useState('');
  useEffect(() => { void getOrCreateAuthToken().then(setAuthToken); }, []);

  const onRegenerateToken = useCallback(async () => {
    const newToken = generateAuthToken();
    localStorage.setItem('auth-token', newToken);
    await chrome.storage.local.set({ 'auth-token': newToken });
    setAuthToken(newToken);
  }, []);

  return (
    <div className='auth-token-section'>
      <div className='auth-token-description'>
        Set this environment variable to bypass the connection dialog:
      </div>
      <div className='auth-token-container'>
        <code className='auth-token-code'>{authTokenCode(authToken)}</code>
        <button className='auth-token-refresh' title='Generate new token' aria-label='Generate new token'onClick={onRegenerateToken}>{icons.refresh()}</button>
        <CopyToClipboard value={authTokenCode(authToken)} />
      </div>
    </div>
  );
};

function authTokenCode(authToken: string) {
  return `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${authToken}`;
}

function generateAuthToken(): string {
  // Generate a cryptographically secure random token
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  // Convert to base64 and make it URL-safe
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
      .replace(/[+/=]/g, match => {
        switch (match) {
          case '+': return '-';
          case '/': return '_';
          case '=': return '';
          default: return match;
        }
      });
}

export const getOrCreateAuthToken = async (): Promise<string> => {
  const stored = await chrome.storage.local.get('auth-token');
  let token = stored['auth-token'] || localStorage.getItem('auth-token');
  if (!token) {
    token = generateAuthToken();
    localStorage.setItem('auth-token', token);
  }
  await chrome.storage.local.set({ 'auth-token': token });
  return token;
};
