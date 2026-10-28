#!/usr/bin/env python3
"""Validate this task's independent candidate through the shared maintenance runner."""
import importlib.util
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
maintenance = root.parent / 'pi-web维护' / 'native-agent-switcher'
sys.path.insert(0, str(maintenance))
spec = importlib.util.spec_from_file_location('prompt_suggestions_flow', maintenance / 'flow.py')
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)
config = json.loads((maintenance / 'local-update.json').read_text())
config['sourceDirectory'] = str((maintenance / config['sourceDirectory']).resolve())
config['candidateDirectory'] = str(root / 'candidate' / 'package')
config['historyFixtureFile'] = str((maintenance / config['historyFixtureFile']).resolve())
settings = root / 'candidate' / 'validation-config'
settings.mkdir(parents=True, exist_ok=True)
(settings / 'local-update.json').write_text(json.dumps(config, indent=2) + '\n')
report = flow.precheck.preflight(here=settings, phase='candidate')
print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
if not report['passed']:
    raise SystemExit(1)
result = flow.validate(report, profile='ui', tests=(
    'components/ChatInput.test.mjs',
    'components/ChatInput.suggestions.test.mjs',
    'lib/prompt-suggestions.test.mjs',
    'lib/extension-widgets.test.mjs',
), jobs=2)
print(json.dumps({key: result[key] for key in ['status', 'coverage', 'elapsedSeconds', 'remaining']}, ensure_ascii=False, indent=2))
