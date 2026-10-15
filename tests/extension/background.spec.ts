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
import { chromium } from 'playwright';
import { test, expect, clickAllowAndSelect } from './extension-fixtures';

test('background mode preserves the user tab during connect, new, select and input', async ({ startClient, pathToExtension, server }, testInfo) => {
  server.setContent('/background.html', '<title>Background</title><input aria-label="Name"><button onclick="this.textContent = \'Clicked\'">Click</button>', 'text/html');
  server.setContent('/controlled.html', '<title>MCP Controlled</title>', 'text/html');
  // Capture the bootstrap URL instead of launching a visible singleton browser.
  const argsFile = testInfo.outputPath('connect-args.json');
  const executablePath = testInfo.outputPath('capture-connect');
  await fs.writeFile(executablePath, '#!/usr/bin/env node\n' +
    'require("fs").writeFileSync(' + JSON.stringify(argsFile) + ', JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const browserContext = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
  });
  try {
    const controlledPage = browserContext.pages()[0];
    await controlledPage.goto(server.PREFIX + '/controlled.html');
    const userPage = await browserContext.newPage();
    await userPage.goto(server.EMPTY_PAGE);
    const { client } = await startClient({
      args: ['--extension', '--executable-path', executablePath],
      env: { PLAYWRIGHT_MCP_EXTENSION_NO_FOCUS: '1' },
    });
    if (!browserContext.serviceWorkers().length)
      await browserContext.waitForEvent('serviceworker');
    const [sw] = browserContext.serviceWorkers();
    await sw.evaluate(() => {
      const g = globalThis as any;
      g.__focusCalls = [];
      for (const [api, method] of [['tabs', 'update'], ['windows', 'update']]) {
        const original = g.chrome[api][method].bind(g.chrome[api]);
        g.chrome[api][method] = (...args: any[]) => {
          g.__focusCalls.push([api, ...args]);
          return original(...args);
        };
      }
    });
    const navigate = client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    await expect.poll(async () => fs.readFile(argsFile, 'utf8').catch(() => '')).not.toBe('');
    const args = JSON.parse(await fs.readFile(argsFile, 'utf8')) as string[];
    const connectUrl = args.find(arg => arg.startsWith('chrome-extension://'))!;
    const connectPagePromise = browserContext.waitForEvent('page');
    await sw.evaluate(url => (globalThis as any).chrome.tabs.create({ url, active: false }), connectUrl);
    const connectPage = await connectPagePromise;
    await clickAllowAndSelect(connectPage, 'MCP Controlled');
    await navigate;
    expect(await sw.evaluate(() => (globalThis as any).__focusCalls)).toEqual([]);

    await userPage.bringToFront();
    const activeTab = () => sw.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0]?.id;
    });
    const userTabId = await activeTab();
    expect(userTabId).toBeDefined();

    expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: server.PREFIX + '/background.html' } })).toHaveResponse({ isError: undefined });
    expect(await activeTab()).toBe(userTabId);
    expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } })).toHaveResponse({ isError: undefined });
    expect(await activeTab()).toBe(userTabId);
    expect(await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 1 } })).toHaveResponse({ isError: undefined });
    expect(await client.callTool({
      name: 'browser_run_code_unsafe',
      arguments: { code: 'async page => { await page.getByRole("textbox").fill("background input"); await page.getByRole("button").click(); return [await page.getByRole("textbox").inputValue(), await page.getByRole("button").textContent()]; }' },
    })).toHaveResponse({ result: expect.stringContaining('background input') });
    expect(await activeTab()).toBe(userTabId);
  } finally {
    await browserContext.close();
  }
});
