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

import fs from 'fs/promises';
import net from 'net';
import http from 'http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { test, expect, extensionId, clickAllowAndSelect } from './extension-fixtures';

const background = test.extend<{
  setup: { context: any, sw: any, token: string, port: number, executablePath: string, marker: string, active: () => Promise<number> },
}>({
  setup: async ({ pathToExtension }, use, testInfo) => {
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const marker = testInfo.outputPath('browser-was-launched');
    const executablePath = testInfo.outputPath('forbidden-browser');
    await fs.writeFile(executablePath, '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(marker) + ', "unexpected");\n', { mode: 0o755 });
    const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
    });
    try {
      const token = 'isolated-test-' + crypto.randomUUID();
      await context.addInitScript(({ token, extensionId }) => {
        if (location.origin === 'chrome-extension://' + extensionId)
          localStorage.setItem('auth-token', token);
      }, { token, extensionId });
      const status = await context.newPage();
      await status.goto(`chrome-extension://${extensionId}/status.html`);
      await expect(status.locator('.auth-token-code')).toHaveText('PLAYWRIGHT_MCP_EXTENSION_TOKEN=' + token);
      await status.getByRole('spinbutton', { name: 'Local connection port' }).fill(String(port));
      await status.getByRole('button', { name: 'Save', exact: true }).click();
      if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
      const sw = context.serviceWorkers()[0];
      expect(await sw.evaluate(() => (globalThis as any).chrome.storage.local.get('auth-token'))).toEqual({ 'auth-token': token });
      await status.close();
      const userPage = context.pages()[0];
      await userPage.bringToFront();
      const active = () => sw.evaluate(async () => (await (globalThis as any).chrome.tabs.query({ active: true }))[0].id);
      await sw.evaluate(() => {
        const g = globalThis as any;
        g.__focusCalls = [];
        for (const api of ['tabs', 'windows']) {
          const original = g.chrome[api].update.bind(g.chrome[api]);
          g.chrome[api].update = (...args: any[]) => { g.__focusCalls.push([api, ...args]); return original(...args); };
        }
        const create = g.chrome.tabs.create.bind(g.chrome.tabs);
        g.__createdTabs = [];
        g.chrome.tabs.create = (properties: any) => { g.__createdTabs.push(properties); return create(properties); };
      });
      await use({ context, sw, token, port, executablePath, marker, active });
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
      const currentWorker = context.serviceWorkers()[0];
      expect(await currentWorker.evaluate(() => (globalThis as any).__focusCalls ?? [])).toEqual([]);
    } finally { await context.close(); }
  },
});

background('background handshake creates no pages and input stays in background', async ({ setup, startClient, server }) => {
  const { context, sw, token, port, executablePath, active } = setup;
  const userTab = await active();
  const pages = context.pages().length;
  const { client } = await startClient({ args: ['--extension', '--executable-path', executablePath], env: {
    PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT: String(port),
  } });
  expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ isError: undefined });
  expect(context.pages()).toHaveLength(pages);
  expect(await sw.evaluate(() => (globalThis as any).__createdTabs)).toEqual([]);
  expect(await active()).toBe(userTab);
  server.setContent('/background.html', '<title>Background</title><input aria-label="Name"><button onclick="this.textContent=\'Clicked\'">Click</button>', 'text/html');
  expect(await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/background.html' } })).toHaveResponse({ isError: undefined });
  expect(await client.callTool({ name: 'browser_run_code_unsafe', arguments: {
    code: 'async page => { await page.getByRole("textbox").fill("background input"); await page.getByRole("button").click(); return [await page.getByRole("textbox").inputValue(), await page.getByRole("button").textContent()]; }',
  } })).toHaveResponse({ result: expect.stringContaining('Clicked') });
  expect(await client.callTool({ name: 'browser_take_screenshot', arguments: {} })).toHaveResponse({ isError: undefined });
  expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: server.EMPTY_PAGE } })).toHaveResponse({ isError: undefined });
  expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } })).toHaveResponse({ isError: undefined });
  expect(await active()).toBe(userTab);
  const created = await sw.evaluate(() => (globalThis as any).__createdTabs);
  expect(created).toHaveLength(2);
  expect(created.every((properties: any) => properties.active === false && !properties.url?.includes('connect.html'))).toBe(true);
  await client.close();
});

background('multiple MCP processes isolate sessions and take over discovery', async ({ setup, startClient, server }) => {
  test.setTimeout(60000);
  const { sw, token, port, executablePath, active } = setup;
  const userTab = await active();
  const start = (clientName: string) => startClient({ clientName, args: ['--extension', '--executable-path', executablePath], env: {
    PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT: String(port),
  } });
  const first = (await start('first')).client;
  expect(await first.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ isError: undefined });
  const second = (await start('second')).client;
  expect(await second.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ isError: undefined });
  await first.close();
  // A new third client must reach discovery now owned by the surviving second process.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const third = (await start('third')).client;
  expect(await third.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } })).toHaveResponse({ isError: undefined });
  expect(await second.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ result: expect.not.stringContaining('hello-world') });
  expect(await active()).toBe(userTab);
  await second.close(); await third.close();
  await expect.poll(() => sw.evaluate(async () => (await (globalThis as any).chrome.tabs.query({})).filter((tab: any) => tab.groupId !== -1).length)).toBe(0);
});

background('wrong token fails without creating pages or launching Chrome', async ({ setup, startClient }) => {
  const { context, port, executablePath } = setup;
  const count = context.pages().length;
  const { client } = await startClient({ args: ['--extension', '--executable-path', executablePath], env: {
    PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'wrong-token', PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT: String(port), PWTEST_EXTENSION_CONNECT_TIMEOUT: '1500',
  } });
  const response = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  expect(response.isError).toBe(true);
  expect(context.pages()).toHaveLength(count);
});

background('occupied port reports an error without launching Chrome', async ({ setup, startClient }) => {
  const { token, port, executablePath, context } = setup;
  const count = context.pages().length;
  const occupied = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  await new Promise<void>(resolve => occupied.listen(port, '127.0.0.1', resolve));
  try {
    const { client } = await startClient({ args: ['--extension', '--executable-path', executablePath], env: {
      PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT: String(port),
    } });
    expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({ isError: true, error: expect.stringContaining('Port is occupied') });
    expect(context.pages()).toHaveLength(count);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

background('extension rejects a forged server and ignores pre-auth sessions', async ({ setup }) => {
  const { port, context, sw, active } = setup;
  const userTab = await active();
  const count = context.pages().length;
  let connectionCount = 0;
  let complete!: () => void;
  const done = new Promise<void>(resolve => complete = resolve);
  const malicious = new WebSocketServer({ port, host: '127.0.0.1' });
  malicious.on('connection', socket => {
    connectionCount++;
    socket.send(JSON.stringify({ type: 'challenge', nonce: 'a'.repeat(64) }));
    socket.once('message', () => {
      socket.send(JSON.stringify({ type: 'session', session: { id: 'forged', url: 'ws://127.0.0.1:' + port + '/extension/forged', key: 'b'.repeat(64), clientName: 'forged' } }));
      socket.send(JSON.stringify({ type: 'ready', proof: 'c'.repeat(64) }));
    });
    socket.on('close', () => complete());
  });
  try {
    await done;
    expect(connectionCount).toBe(1);
    expect(context.pages()).toHaveLength(count);
    expect(await sw.evaluate(() => (globalThis as any).__createdTabs)).toEqual([]);
    expect(await active()).toBe(userTab);
  } finally {
    for (const socket of malicious.clients) socket.terminate();
    await new Promise<void>(resolve => malicious.close(() => resolve()));
  }
});

background('extension reload recovers without replaying input', async ({ setup, startClient, server }) => {
  test.setTimeout(60000);
  const { token, port, executablePath, context, sw } = setup;
  server.setContent('/once.html', '<title>Once</title><button onclick="localStorage.setItem(\'clicks\', String(Number(localStorage.getItem(\'clicks\') || 0) + 1))">Click once</button>', 'text/html');
  const { client } = await startClient({ args: ['--extension', '--executable-path', executablePath], env: {
    PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1', PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXTENSION_BRIDGE_PORT: String(port),
  } });
  expect(await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/once.html' } })).toHaveResponse({ isError: undefined });
  expect(await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: 'async page => { await page.getByRole("button").click(); return await page.evaluate(() => localStorage.getItem("clicks")); }' } })).toHaveResponse({ result: expect.stringContaining('1') });
  const taskPage = context.pages().find((page: any) => page.url().endsWith('/once.html'))!;
  const count = context.pages().length;
  const restarted = context.waitForEvent('serviceworker');
  await sw.evaluate(() => (globalThis as any).chrome.runtime.reload()).catch(() => {});
  const newWorker = await restarted;
  // A disconnected CDP context is recreated on the next read-only tool call.
  await expect.poll(async () => {
    const result = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    return result.isError ?? false;
  }, { timeout: 45000 }).toBe(false);
  expect(context.pages()).toHaveLength(count);
  expect(await taskPage.evaluate(() => localStorage.getItem('clicks'))).toBe('1');
  // Replace the fixture's recorders after a worker restart without accessing user pages.
  await newWorker.evaluate(() => { (globalThis as any).__focusCalls = []; });
  await client.close();
});

test('ordinary extension mode remains compatible in a headless browser', async ({ pathToExtension, startClient, server }, testInfo) => {
  server.setContent('/legacy.html', '<title>Legacy controlled</title>', 'text/html');
  const argsFile = testInfo.outputPath('legacy-args.json');
  const executablePath = testInfo.outputPath('capture-legacy');
  await fs.writeFile(executablePath, '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(argsFile) + ', JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const context = await chromium.launchPersistentContext(testInfo.outputPath('legacy-profile'), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });
  try {
    await context.pages()[0].goto(server.PREFIX + '/legacy.html');
    const { client } = await startClient({ args: ['--extension', '--executable-path', executablePath], env: { PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '0', PLAYWRIGHT_MCP_EXTENSION_TOKEN: '' } });
    const navigation = client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    await expect.poll(() => fs.readFile(argsFile, 'utf8').catch(() => '')).not.toBe('');
    const args: string[] = JSON.parse(await fs.readFile(argsFile, 'utf8'));
    const url = new URL(args.find(arg => arg.startsWith('chrome-extension://'))!);
    // Only the test opens the authorization page, inside this headless browser.
    url.searchParams.set('noFocus', '1');
    const connect = await context.newPage();
    await connect.goto(url.href);
    await clickAllowAndSelect(connect, 'Legacy controlled');
    expect(await navigation).toHaveResponse({ snapshot: expect.stringContaining('Hello, world!') });
    await client.close();
  } finally { await context.close(); }
});
