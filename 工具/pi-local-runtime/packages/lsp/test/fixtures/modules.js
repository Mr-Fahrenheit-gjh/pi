import * as tools from '../../src/tools.js';
import * as index from '../../src/index.js';
import * as prompt from '../../src/prompt.js';
import * as client from '../../src/client.js';
import * as dependencies from '../../src/dependencies.js';
import * as servers from '../../src/servers.js';
import * as serverManager from '../../src/server-manager.js';
export default pi => { pi.events.emit('lsp-test:modules', { ...tools, ...index, ...prompt, ...client, ...dependencies, ...servers, ...serverManager }); };
