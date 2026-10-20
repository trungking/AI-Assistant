// Run: node --experimental-vm-modules --test tests/extension-messaging.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const noReceiver = () => new Error('Could not establish connection. Receiving end does not exist.');
const event = () => {
    const listeners = new Set();
    return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
};

async function loadSource(file, globals) {
    const source = ts.transpileModule(await readFile(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const module = new vm.SourceTextModule(source, { context: vm.createContext({ Error, ...globals }) });
    await module.link(() => { throw new Error('Unexpected dependency'); });
    await module.evaluate();
    return module.namespace;
}

test('menu image: missing receiver injects content once and sends to top frame', async () => {
    const calls = [];
    const chrome = {
        tabs: { async sendMessage(...args) { calls.push(['send', ...args]); if (calls.length === 1) throw noReceiver(); return { opened: true }; } },
        scripting: { async executeScript(options) { calls.push(['inject', options]); } },
    };
    const { sendToContentScript } = await loadSource('src/background/contentMessaging.ts', { chrome });
    await sendToContentScript(42, { action: 'open_content_popup', image: 'data:image/png;base64,abc' });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.map(call => call[0]))), ['send', 'inject', 'send']);
    assert.equal(calls[0][3].frameId, 0);
    assert.equal(calls[1][1].target.tabId, 42);
    assert.equal(calls[1][1].files[0], 'assets/content.js');
});

test('content delivery does not retry permission failures or hide popup errors', async () => {
    let injections = 0;
    const chrome = {
        tabs: { async sendMessage() { throw new Error('Permission denied'); } },
        scripting: { async executeScript() { injections++; } },
    };
    const { sendToContentScript } = await loadSource('src/background/contentMessaging.ts', { chrome });
    await assert.rejects(sendToContentScript(1, {}), /Permission denied/);
    assert.equal(injections, 0);
    chrome.tabs.sendMessage = async () => ({ error: 'Storage failed' });
    await assert.rejects(sendToContentScript(1, {}), /Storage failed/);
});

test('refresh injects web tabs only and tolerates closed/restricted tabs', async () => {
    const injected = [];
    const chrome = {
        tabs: { async query() { return [{ id: 1, url: 'https://x.com/' }, { id: 2, url: 'http://example.com' }, { id: 3, url: 'chrome://extensions' }, { url: 'https://x.com' }]; } },
        scripting: { async executeScript({ target }) { injected.push(target.tabId); if (target.tabId === 2) throw new Error('Tab closed'); } },
    };
    const { refreshContentScripts } = await loadSource('src/background/contentMessaging.ts', { chrome });
    await refreshContentScripts();
    assert.deepEqual(injected, [1, 2]);
});

async function captureWith(sendMessage) {
    const delays = [];
    const module = await loadSource('src/content/captureScreenshot.ts', {
        chrome: { runtime: { sendMessage } }, setTimeout: (fn, delay) => { delays.push(delay); fn(); },
    });
    return { capture: module.captureScreenshot, delays };
}

test('capture retries missing worker receiver and succeeds', async () => {
    let attempts = 0;
    const { capture, delays } = await captureWith(async () => {
        if (++attempts < 3) throw noReceiver();
        return { dataUrl: 'data:image/png;base64,abc' };
    });
    assert.equal(await capture(), 'data:image/png;base64,abc');
    assert.deepEqual(delays, [200, 400]);
});

test('capture gives actionable persistent and invalidated context errors', async () => {
    let attempts = 0;
    const { capture } = await captureWith(async () => { attempts++; throw noReceiver(); });
    await assert.rejects(capture(), /chrome:\/\/extensions.*refresh this page/);
    assert.equal(attempts, 3);
    const invalid = await captureWith(async () => { throw new Error('Extension context invalidated.'); });
    await assert.rejects(invalid.capture(), /Refresh this page/);
    assert.deepEqual(invalid.delays, []);
});

test('capture never retries actual capture errors or empty responses', async () => {
    for (const response of [{ error: 'Capture permission denied' }, undefined]) {
        let attempts = 0;
        const { capture, delays } = await captureWith(async () => { attempts++; return response; });
        await assert.rejects(capture(), /permission denied|no screenshot/);
        assert.equal(attempts, 1);
        assert.deepEqual(delays, []);
    }
});

test('built worker starts without DOM and keeps screenshot response channel open', async () => {
    const onMessage = event();
    const chrome = {
        runtime: { onInstalled: event(), onMessage, onConnect: event() },
        contextMenus: { onClicked: event() },
        tabs: { async captureVisibleTab(windowId, options) { assert.equal(windowId, 7); assert.equal(options.format, 'png'); return 'data:image/png;base64,abc'; } },
        windows: { WINDOW_ID_CURRENT: -2 },
    };
    const context = vm.createContext({ chrome, console });
    const modules = new Map();
    async function load(file) {
        if (modules.has(file)) return modules.get(file);
        const module = new vm.SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file });
        modules.set(file, module);
        await module.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
        return module;
    }
    await (await load(path.resolve('dist/assets/background.js'))).evaluate();
    assert.equal(onMessage.listeners.size, 1);
    const response = await new Promise(resolve => {
        const listener = [...onMessage.listeners][0];
        assert.equal(listener({ action: 'capture_screenshot' }, { tab: { windowId: 7 } }, resolve), true);
    });
    assert.equal(response.dataUrl, 'data:image/png;base64,abc');
});

test('content reinjection retains one hotkey/message listener and replaces invalidated context', async () => {
    const onMessage = event(), onChanged = event(), keydown = event();
    const runtime = { id: 'extension-id', onMessage };
    const context = vm.createContext({
        chrome: { runtime, storage: { sync: { onChanged, get: async () => ({}) }, local: { get: async () => ({}) } } },
        console,
        window: { addEventListener: (name, fn) => { assert.equal(name, 'keydown'); keydown.addListener(fn); }, removeEventListener: (_, fn) => keydown.removeListener(fn) },
    });
    const source = ts.transpileModule(await readFile('src/content/index.ts', 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const popupModule = new vm.SyntheticModule(['openContentPopup', 'closeContentPopup', 'isContentPopupOpen', 'forceCloseContentPopup'], function () {
        for (const name of ['openContentPopup', 'closeContentPopup', 'isContentPopupOpen', 'forceCloseContentPopup']) this.setExport(name, () => {});
    }, { context });
    const cropModule = new vm.SyntheticModule(['startCropMode', 'cancelCropMode'], function () {
        this.setExport('startCropMode', () => {}); this.setExport('cancelCropMode', () => {});
    }, { context });
    const storageModule = new vm.SyntheticModule(['getStorage', 'isConfigStorageChange'], function () {
        this.setExport('getStorage', async () => ({ prompts: [], customHotkey: null, cropHotkey: null }));
        this.setExport('isConfigStorageChange', changes => 'appConfig' in changes);
    }, { context });
    async function inject() {
        const module = new vm.SourceTextModule(source, { context });
        await module.link(specifier => specifier.endsWith('ContentPopup') ? popupModule
            : specifier.endsWith('storage') ? storageModule
                : cropModule);
        await module.evaluate();
    }
    await inject(); await inject();
    assert.equal(onMessage.listeners.size, 1); assert.equal(keydown.listeners.size, 1);
    runtime.id = undefined;
    context.chrome.runtime = { id: 'extension-id', onMessage };
    await inject();
    assert.equal(onMessage.listeners.size, 1); assert.equal(keydown.listeners.size, 1); assert.equal(onChanged.listeners.size, 1);
    const listener = [...onMessage.listeners][0];
    const response = await new Promise(resolve => assert.equal(listener({ action: 'open_content_popup', image: 'data:image/png;base64,abc' }, {}, resolve), true));
    assert.equal(response.opened, true);
});

test('crop starts transparent and uses bitmap dimensions at Retina/browser zoom', async () => {
    let states = [false, { x: 10, y: 20 }, { x: 110, y: 70 }, null, null];
    let stateIndex = 0;
    let drawArgs;
    let canvas;
    let completed;
    const context = vm.createContext({
        console,
        window: { innerWidth: 1000, innerHeight: 500, devicePixelRatio: 2 },
        document: { createElement() { canvas = { getContext: () => ({ drawImage: (...args) => { drawArgs = args; } }), toDataURL: () => 'cropped' }; return canvas; } },
        Image: class {
            naturalWidth = 1600; naturalHeight = 800;
            set src(_) { this.onload(); }
        },
    });
    const jsx = (_, props) => props;
    const exports = {
        'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
        'react-dom/client': { createRoot: () => {} },
        'react': { useState: () => [states[stateIndex++], () => {}], useEffect: () => {}, useCallback: fn => fn },
        './captureScreenshot': { captureScreenshot: async () => 'screenshot' },
    };
    const source = ts.transpileModule(await readFile('src/content/CropOverlay.tsx', 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const module = new vm.SourceTextModule(source, { context });
    await module.link(specifier => new vm.SyntheticModule(Object.keys(exports[specifier]), function () {
        for (const [name, value] of Object.entries(exports[specifier])) this.setExport(name, value);
    }, { context }));
    await module.evaluate();
    const render = () => module.namespace.default({ onComplete: value => { completed = value; }, onCancel: () => {} });
    const loading = render();
    assert.equal(loading.style.backgroundColor, 'transparent');
    assert.equal(loading.children, null);
    states[0] = true; states[3] = 'screenshot'; stateIndex = 0;
    const overlay = render();
    await overlay.children[0].onMouseUp();
    assert.equal(canvas.width, 160); assert.equal(canvas.height, 80);
    assert.deepEqual(drawArgs.slice(1), [16, 32, 160, 80, 0, 0, 160, 80]);
    assert.equal(completed, 'cropped');
});
