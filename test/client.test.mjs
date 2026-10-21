import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL(`../${pkg.exports['./client']}`, import.meta.url), 'utf8');

function registerClient() {
  const registrations = [];
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  });
  return registrations;
}

test('the exported client registers exactly once under the full package name', () => {
  // Registration must be lazy: no React, DOM or network access is available here.
  const registrations = registerClient();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, pkg.name);
  assert.equal(typeof registrations[0].factory, 'function');
});

test('materializing the client registers its prompt through the overlay slot', () => {
  const [registration] = registerClient();
  const required = [];
  const plugin = registration.factory((name) => {
    required.push(name);
    assert.equal(name, 'react');
    return { createElement() {} };
  });
  assert.deepEqual(required, ['react']);
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
  let mounted = 0;
  plugin.apply({ slots: {
    inject(slot, callback) {
      assert.equal(slot, 'shell.overlay');
      callback();
    },
    register(options, component) {
      assert.equal(options.name, 'shell.overlay');
      assert.equal(options.id, 'dsh-auto-update.prompt');
      assert.equal(typeof component, 'function');
      mounted++;
    },
  } });
  assert.equal(mounted, 1);
});

const runtimePath = process.env.DSH_CLIENT_MODULES_TEST_PATH;
test('installed DSH loader imports the scoped package without retrying its bundle', {
  skip: !runtimePath && 'Set DSH_CLIENT_MODULES_TEST_PATH to an installed DSH client-modules bundle',
}, async () => {
  const target = {
    mode: 'queue', pendingQueue: [],
    load(registration) { this.pendingQueue.push(registration); },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: target },
    document: { querySelectorAll: () => [] },
    URL, console,
  });
  vm.runInContext(readFileSync(runtimePath, 'utf8'), context);
  const bootstrap = target.pendingQueue.shift();
  const api = bootstrap.factory(() => { throw new Error('Unexpected bootstrap dependency'); });
  const requests = [];
  const system = new api.ClientModuleSystem({
    manifest: { modules: [{
      id: pkg.name, inject: [], external: ['react'], rev: 'test',
      initialUrl: '/batch.js', url: '/single.js',
    }], entries: [] },
    staticModules: { react: { createElement() {} } },
    registrationTarget: target,
    bootstrapModule: { id: bootstrap.id, exports: api },
    loadBundle: async (url) => {
      requests.push(url);
      vm.runInContext(source, context);
    },
  });
  const plugin = await system.import(pkg.name);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(await system.import(pkg.name), plugin);
  assert.deepEqual(requests, ['/batch.js']);
});
