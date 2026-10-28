import { create_shared_child_process_env } from './dependencies.js';
export function create_child_process_env(explicit_env = {}, source_env = process.env) {
    return create_shared_child_process_env({
        profile: 'lsp',
        explicit_env,
        source_env,
    });
}
