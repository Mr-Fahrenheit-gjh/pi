import { fileURLToPath, pathToFileURL } from 'node:url';
export const cliHost = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
export const webHost = '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent';
export async function loadModules(host = process.env.PI_LSP_TEST_HOST ?? cliHost) {
 const { loadExtensions } = await import(pathToFileURL(`${host}/dist/core/extensions/loader.js`));
 const { createEventBus } = await import(pathToFileURL(`${host}/dist/core/event-bus.js`));
 const bus = createEventBus(); let modules;
 bus.on('lsp-test:modules', value => { modules = value; });
 const result = await loadExtensions([fileURLToPath(new URL('./fixtures/modules.js', import.meta.url))], process.cwd(), bus);
 if (result.errors.length) throw Error(JSON.stringify(result.errors));
 result.runtime.invalidate();
 return modules;
}
