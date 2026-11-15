#!/usr/bin/env python3
"""Read archive frontmatter only. Does not alter raw records or inspect auth files."""
import json
from pathlib import Path
import re


def inspect(root):
    result = {}
    for source in sorted(p for p in root.iterdir() if p.is_dir()):
        count = 0
        latest = None
        weak_titles = 0
        for p in source.rglob('*.md'):
            count += 1
            with p.open() as f:
                header = ''.join(f.readline() for _ in range(25))
            match = re.search(r'^updated:\s*[\"\']?([^\"\'\n]+)', header, re.M)
            if match and (latest is None or match.group(1) > latest):
                latest = match.group(1)
            title = re.search(r'^title:\s*[\"\']?([^\"\'\n]+)', header, re.M)
            if title and title.group(1).strip() in {'随便', '继续', 'hi', '你好', '可以'}:
                weak_titles += 1
        result[source.name] = {'files': count, 'latest_recorded_update': latest,
                               'weak_title_count': weak_titles}
    return {'archive': str(root), 'sources': result,
            'warning': 'Coverage timestamps are not completeness guarantees. Index refresh cannot recover sessions that were never exported. Raw files were not changed.'}


if __name__ == '__main__':
    root = Path.home() / 'Documents/Obsidian Vault/AI/raw/conversations'
    print(json.dumps(inspect(root), ensure_ascii=False, indent=2))
