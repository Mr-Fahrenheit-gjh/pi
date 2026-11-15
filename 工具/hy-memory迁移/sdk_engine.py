"""Configure the official Hy-Memory client; no custom extraction/retrieval implementation."""
from __future__ import annotations

import logging
import os
from pathlib import Path


def strict_reconcile_result(result):
    if result.degraded:
        result.success = False
        result.error = 'reconcile_backend_unavailable_no_fallback_persisted'
        result.ops = []
    return result


def make_client(directory: Path, token_file: Path):
    os.umask(0o077)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    for existing in directory.rglob('*'):
        if existing.is_symlink():
            raise RuntimeError('sdk_store_symlink_refused')
        existing.chmod(0o700 if existing.is_dir() else 0o600)
    log_directory = directory / 'logs' / 'pipeline'
    log_directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(directory / 'logs', 0o700)
    os.chmod(log_directory, 0o700)
    # SDK JSONL logs cannot be disabled by TRACE_ENABLED. They may contain parsed
    # facts, so keep them inside the private store; never treat them as redacted.
    os.environ['MEMORY_DATA_DIR'] = str(directory)
    os.environ['MEMORY_LOG_DIR'] = str(log_directory)
    os.environ['MEMORY_LOG_LLM_CONTENT'] = 'false'
    # Disable optional asynchronous DB traces, not the independent JSONL sink.
    os.environ['MEMORY_PIPELINE_TRACE_ENABLED'] = 'false'
    os.environ['MEMORY_SEARCH_DEDUP_ENABLED'] = 'false'
    os.environ['MEMORY_ENABLE_INTENTION'] = 'false'
    os.environ['MEMORY_ENABLE_QUERY_REWRITE'] = 'false'
    os.environ['ANONYMIZED_TELEMETRY'] = 'false'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    logging.disable(logging.CRITICAL)
    from hy_memory import HyMemoryClient
    from importlib.metadata import version
    if version('hy-memory') != '2.0.2':
        raise RuntimeError('sdk_version_changed_revalidate_adapter')
    # SDK 2.0.2 otherwise reports success after a degraded ADD_ALL fallback.
    # Preserve its official algorithm, but fail closed BEFORE fallback facts are persisted.
    from hy_memory.agent.reconciler import MemoryReconciler
    if not getattr(MemoryReconciler, '_pi_strict_adapter', False):
        original = MemoryReconciler.reconcile
        async def strict_reconcile(self, *args, **kwargs):
            result = await original(self, *args, **kwargs)
            return strict_reconcile_result(result)
        MemoryReconciler.reconcile = strict_reconcile
        MemoryReconciler._pi_strict_adapter = True
    token = token_file.read_text().strip()
    return HyMemoryClient.from_config({
        'mode': 'pro', 'enable_graph': False,
        'llm': {'provider': 'openai', 'base_url': 'http://127.0.0.1:30147/v1',
            'api_key': token, 'model': 'gpt-6.1-sol', 'omit_temperature': True,
            'max_tokens': 4096, 'agent_max_tokens': 4096, 'timeout': 240,
            # SDK 2.0.2 treats max_retries as TOTAL attempts, unlike the OpenAI client.
            'max_retries': 1, 'few_shot_enabled': True, 'enable_intention': False,
            'enable_query_rewrite': False},
        'embedder': {'provider': 'openai', 'base_url': 'http://127.0.0.1:30147/v1',
            'api_key': token, 'model': 'qmd-embeddinggemma-300m', 'embedding_dims': 768,
            'timeout': 180, 'max_retries': 0},
        'vector_store': {'provider': 'chroma', 'embedding_dims': 768,
            'collection_name': 'pi_hy_memory', 'persist_directory': str(directory / 'vectors')},
        'cache': {'backend': 'sqlite', 'db_path': str(directory / 'cache.sqlite3')},
        'history': {'enable': True, 'record_searches': False, 'db_path': str(directory / 'history.sqlite3')},
        'coding': {'db_path': str(directory / 'coding.sqlite3')},
        'graph_store': {'provider': 'kuzu', 'db_path': str(directory / 'graph')},
    })


def memory_items(result):
    value = result.get('memories', {})
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [item for channel in value.values() if isinstance(channel, list) for item in channel if isinstance(item, dict)]
    return []


def checked_write(client, result):
    if result.get('success') is not True or result.get('agent_error_code') or result.get('partial_agent_persist'):
        raise RuntimeError('hy_write_failed_or_partial')
    # In pro mode add().memory_id identifies private L1_RAW, which get() intentionally hides.
    # memory_ids are the public, canonical fact nodes that MUST be checked instead.
    ids = list(dict.fromkeys(result.get('memory_ids', []) or
        ([result['memory_id']] if result.get('memory_id') and 'agent_status' not in result else [])))
    token_parts=[result.get(name) or {} for name in ('extract_tokens','reconcile_tokens')]
    inputs=sum(part.get('prompt',0) for part in token_parts)
    outputs=sum(part.get('completion',0) for part in token_parts)
    usage={'input':inputs,'output':outputs,'cacheRead':0,'cacheWrite':0,'totalTokens':inputs+outputs,
        'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'total':0}}
    if not ids:
        # A successful reconcile NOOP can produce no IDs; it is not proof of a newly stored fact.
        return {'success': True, 'verified_ids': [], 'noop': True, 'request_id': result.get('request_id'),'usage':usage}
    verified = []
    for memory_id in ids:
        memory = client.get(memory_id)
        if not memory or not memory.get('content'):
            raise RuntimeError('hy_write_readback_failed')
        verified.append(memory_id)
    return {'success': True, 'verified_ids': verified, 'noop': False, 'request_id': result.get('request_id'),'usage':usage}
