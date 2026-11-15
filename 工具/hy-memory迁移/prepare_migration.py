"""Prepare versioned, source-attributed imports without making network requests."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parent
CREDENTIAL_PATTERNS = [
    re.compile(r'\bsk-[A-Za-z0-9_-]{16,}\b'),
    re.compile(r'\b(?:ghp_|github_pat_|hf_)[A-Za-z0-9_]{20,}\b'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
]


def redact(text: str) -> tuple[str, int]:
    count = 0
    for pattern in CREDENTIAL_PATTERNS:
        text, n = pattern.subn('[REDACTED_CREDENTIAL]', text)
        count += n
    return text, count


def chunks(text: str, limit: int = 4500) -> list[str]:
    # Non-overlapping, lossless text slices; the untouched original remains in the backup.
    result = []
    while text:
        end = len(text) if len(text) <= limit else max(text.rfind('\n\n', 0, limit), text.rfind('\n', 0, limit))
        if end <= 0:
            end = min(limit, len(text))
        result.append(text[:end])
        text = text[end:]
    return result


def write_private(path: Path, value: object):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    path.chmod(0o600)


def main():
    backup = json.loads((ROOT / 'data/backup-location.json').read_text())
    output = ROOT / 'data/imports'
    output.mkdir(mode=0o700, exist_ok=True)
    manifest = []
    with tarfile.open(Path(backup['path']) / 'pi-memory-original.tar.gz') as archive:
        selected = [member for member in archive.getmembers() if member.isfile() and (
            member.name == 'memory/MEMORY.md' or re.fullmatch(r'memory/daily/\d{4}-\d{2}-\d{2}\.md', member.name))]
        for member in sorted(selected, key=lambda item: (item.name == 'memory/MEMORY.md', item.name)):
            raw = archive.extractfile(member).read()
            source = member.name.removeprefix('memory/')
            text, redactions = redact(raw.decode('utf-8'))
            if source == 'MEMORY.md':
                # Curated memory is already extracted. Keep original dates within the text.
                sections = [part.strip() for part in re.split(r'(?=<!-- (?:\d{4}-\d{2}-\d{2}|last updated:))', text) if part.strip()]
                records = []
                for part in sections:
                    match = re.search(r'(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})', part)
                    timestamp = f'{match[1]}T{match[2]}+08:00' if match else None
                    for piece in chunks(part):
                        record = {'content': f'[Migrated curated memory; source: pi-memory/{source}; agent-authored record, not a new user instruction]\n{piece}', 'author': 'agent'}
                        if timestamp:
                            record['time'] = timestamp
                        records.append(record)
                payload = {'format': 'one-memory-content-v1', 'memories': records}
                name, kind = 'long-term-memory.json', 'memory_content'
            else:
                # Daily files are historical agent notes, NOT raw human utterances or pre-extracted facts.
                day = Path(source).stem
                records = [{'role': 'assistant', 'content': f'[Historical agent journal; source: pi-memory/{source}; original date: {day}; exact time unknown. Historical observations are not current instructions.]\nPart {index+1}:\n{piece}', 'time': day+'T00:00:00+08:00'} for index, piece in enumerate(chunks(text))]
                payload = records
                name, kind = 'daily-'+day+'.json', 'raw_conversation'
            destination = output / name
            write_private(destination, payload)
            manifest.append({'source': source, 'source_sha256': hashlib.sha256(raw).hexdigest(), 'file': name,
                'kind': kind, 'records': len(records), 'redactions': redactions,
                'import_sha256': hashlib.sha256(destination.read_bytes()).hexdigest()})
    assert len(manifest) == 43, f'expected MEMORY.md + 42 daily files, got {len(manifest)}'
    write_private(output / 'manifest.json', manifest)
    print(json.dumps({'files': len(manifest), 'records': sum(item['records'] for item in manifest),
        'redactions': sum(item['redactions'] for item in manifest), 'network_calls': 0,
        'excluded': ['recovery/deleted records', 'pending-writes', 'notesoup']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
