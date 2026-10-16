#!/usr/bin/env python3
"""Read pinned BetterGI trees without executing upstream scripts."""
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import argparse
import json
import re

PROJECT = Path(__file__).resolve().parents[2]
VENDOR = PROJECT / 'third_party/bettergi'

arguments = argparse.ArgumentParser(description=__doc__)
arguments.add_argument('--source', type=Path, default=VENDOR / 'source')
arguments.add_argument('--resources', type=Path, default=VENDOR / 'scripts')
arguments.add_argument('--provenance', type=Path, default=VENDOR / 'provenance.json')
arguments.add_argument('--output', type=Path, default=PROJECT / 'notes/bettergi-inventory.json')
options = arguments.parse_args()
SOURCE = options.source.resolve()
RESOURCES = options.resources.resolve()
APP = SOURCE / 'BetterGenshinImpact'


def tree(root):
    return [{'path': str(p.relative_to(root)), 'sha256': sha256(p.read_bytes()).hexdigest(),
             'bytes': p.stat().st_size}
            for p in sorted(root.rglob('*')) if p.is_file() and '.git' not in p.relative_to(root).parts]


def verified_inventory(name, inventory):
    expected = {entry['path']: entry for entry in provenance[name]['files']}
    actual = {entry['path']: entry for entry in inventory}
    changed = [name for name, entry in actual.items() if name in expected
               and any(entry[key] != expected[name][key] for key in ['sha256', 'bytes'])]
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    if changed or missing or extra:
        raise ValueError(f'{name} import differs from provenance: changed={changed}, missing={missing}, extra={extra}')
    return {'files_verified': len(actual), 'sha256_and_bytes_match': True}


def read(path):
    return path.read_text(encoding='utf-8-sig', errors='replace')


def declarations(path):
    return [{'line': i, 'declaration': line.strip()}
            for i, line in enumerate(read(path).splitlines(), 1)
            if re.match(r'\s*public\s+(?:static\s+)?(?:async\s+)?[^=;{}]+\(', line)]


provenance = json.loads(read(options.provenance))
source_tree = tree(SOURCE)
resource_tree = tree(RESOURCES)
verification = {'source': verified_inventory('source', source_tree),
                'scripts': verified_inventory('scripts', resource_tree)}
engine = read(APP / 'Core/Script/EngineExtend.cs')
bindings = []
for line_no, line in enumerate(engine.splitlines(), 1):
    if line.strip().startswith('//'):
        continue
    m = re.search(r'engine\.AddHost(Object|Type)\("([^"]+)"\s*,\s*(.+)\);', line)
    if m:
        bindings.append({'kind': m[1], 'name': m[2], 'binding': m[3],
                         'source': 'BetterGenshinImpact/Core/Script/EngineExtend.cs', 'line': line_no})

modules = []
for directory in sorted((APP / 'GameTask').iterdir()):
    if not directory.is_dir():
        continue
    cs = sorted(directory.rglob('*.cs'))
    assets = [p for p in directory.rglob('*') if p.is_file() and p.suffix != '.cs']
    modules.append({'name': directory.name, 'cs_count': len(cs), 'non_cs_count': len(assets),
                    'cs_files': [str(p.relative_to(SOURCE)) for p in cs],
                    'entry_files': [str(p.relative_to(SOURCE)) for p in cs
                                    if p.name.endswith(('Task.cs', 'Trigger.cs', 'Macro.cs', 'Executor.cs'))]})

assets = []
recognition_count = 0
recognition_types = Counter()
for p in sorted((APP / 'GameTask').rglob('*')):
    if not p.is_file() or 'Assets' not in p.parts or p.suffix == '.cs':
        continue
    item = {'path': str(p.relative_to(SOURCE)), 'sha256': sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size}
    if p.name == 'Recognition.json':
        d = json.loads(read(p))
        item['recognition_names'] = list(d.get('objects', {}))
        recognition_count += len(d.get('objects', {}))
        recognition_types.update(x.get('type') for x in d.get('objects', {}).values())
    assets.append(item)

roots = sorted(set(x['name'] for x in bindings if x['kind'] == 'Object' and not x['binding'].startswith('GlobalMethod.')) | {'settings'})
global_names = [x['name'] for x in bindings if x['binding'].startswith('GlobalMethod.')]
member_pattern = re.compile(r'\b(' + '|'.join(map(re.escape, roots)) + r')\.([A-Za-z_][A-Za-z_0-9]*)')
global_pattern = re.compile(r'(?<![A-Za-z_0-9.])(' + '|'.join(map(re.escape, global_names)) + r')\s*\(')
packages = []
api_file_counts = Counter()
for manifest_file in sorted((RESOURCES / 'repo/js').glob('*/manifest.json')):
    manifest = json.loads(read(manifest_file))
    script_files = sorted(manifest_file.parent.rglob('*.js'))
    per_file = []
    package_calls = set()
    for p in script_files:
        body = read(p)
        calls = {a + '.' + b for a, b in member_pattern.findall(body)} | set(global_pattern.findall(body))
        package_calls.update(calls)
        api_file_counts.update(calls)
        per_file.append({'path': str(p.relative_to(RESOURCES)), 'lexical_api_references': sorted(calls)})
    packages.append({'directory': str(manifest_file.parent.relative_to(RESOURCES)),
                     'manifest': manifest, 'script_count': len(script_files),
                     'lexical_api_references': sorted(package_calls), 'script_files': per_file})

public_surface = {}
for base in ['Core/Script/Dependence', 'Core/BgiVision', 'GameTask/Model/Area', 'Core/Input']:
    for p in sorted((APP / base).rglob('*.cs')):
        public_surface[str(p.relative_to(SOURCE))] = declarations(p)

method_source = read(APP / 'GameTask/AutoFight/Script/Method.cs')
method_aliases = dict((name, re.findall(r'"([^"]+)"', aliases))
                      for name, aliases in re.findall(r'public static readonly Method (\w+) = new\(\[(.*?)\]\)', method_source))
enabled_methods = re.findall(r'^\s*yield return (\w+);', method_source, re.MULTILINE)
macro_source = read(APP / 'Core/Recorder/Model/MacroEvent.cs')
macro_enum_body = re.search(r'public enum MacroEventType\s*\{([^}]+)', macro_source)[1]
macro_types = re.findall(r'^\s*(\w+)\s*,?\s*$', macro_enum_body, re.MULTILINE)
action_source = read(APP / 'GameTask/AutoPathing/Handler/ActionFactory.cs')
after_actions, before_actions = action_source.split('public static IActionHandler GetBeforeHandler', 1)
execution_contracts = {
    'combat_text': {
        'method_aliases': method_aliases,
        'parser_enabled_methods': enabled_methods,
        'declared_but_parser_disabled_methods': [name for name in method_aliases if name not in enabled_methods],
        'current_avatar_placeholder': '当前角色',
        'default_validation_requires_avatar_prefix': True,
        'round_separator': '|',
        'round_examples': ['round(1)', 'round(1,3,5)', 'round(2-4)', 'round(1,3-5)'],
        'evidence': ['GameTask/AutoFight/Script/Method.cs', 'GameTask/AutoFight/Script/CombatScriptParser.cs',
                     'GameTask/AutoFight/Script/CombatCommand.cs'],
    },
    'macro': {
        'event_type_values': dict(enumerate(macro_types)),
        'time_unit': 'milliseconds from replay start',
        'default_json_event_type_encoding': 'numeric enum (no JsonStringEnumConverter)',
        'absolute_coordinates': '(recorded position - info origin) * current size / info size + current origin; truncate to int',
        'relative_coordinates': 'round(recorded delta / info.recordDpi * currentDpiScale); .NET midpoint-to-even',
        'scroll_steps': 'truncate(mouseY / 120)',
        'camera_correction': 'small orientation error under 8 degrees adjusts MouseX; requires camera orientation recognition',
        'evidence': ['Core/Recorder/Model/MacroEvent.cs', 'Core/Recorder/Model/KeyMouseScript.cs',
                     'Core/Recorder/KeyMouseMacroPlayer.cs', 'Core/Recorder/KeyMouseRecorder.cs'],
    },
    'pathing': {
        'movement_modes': re.findall(r'MoveModeEnum \w+ = new\("([^"]+)"', read(APP / 'GameTask/AutoPathing/Model/Enum/MoveModeEnum.cs')),
        'waypoint_types': re.findall(r'WaypointType \w+ = new\("([^"]+)"', read(APP / 'GameTask/AutoPathing/Model/Enum/WaypointType.cs')),
        'after_actions': re.findall(r'"([^"]+)" => new', after_actions),
        'before_actions': re.findall(r'"([^"]+)" => new', before_actions),
        'executor_inline_actions': ['force_tp', 'log_output'],
        'evidence': ['GameTask/AutoPathing/Handler/ActionFactory.cs', 'GameTask/AutoPathing/Model/Enum/MoveModeEnum.cs',
                     'GameTask/AutoPathing/Model/Enum/WaypointType.cs', 'GameTask/AutoPathing/PathExecutor.cs'],
    },
}

dts = read(RESOURCES / 'bettergi.d.ts')
dts_names = set(re.findall(r'declare (?:const|class|function|namespace|interface) (\w+)', dts))
active_resources = [x for x in resource_tree if x['path'].startswith(('repo/', 'packages/'))]
summary = {
    'game_task_cs_files': len(list((APP / 'GameTask').rglob('*.cs'))),
    'game_task_directories': len(modules),
    'bound_global_functions': len(global_names), 'named_host_bindings': len(bindings),
    'source_asset_files': len(assets), 'recognition_files': sum(p['path'].endswith('/Recognition.json') for p in assets),
    'recognition_objects': recognition_count, 'recognition_types': dict(recognition_types),
    'active_js_packages': len(packages), 'active_js_files': sum(p['script_count'] for p in packages),
    'active_pathing_json_files': sum(x['path'].startswith('repo/pathing/') and x['path'].endswith('.json') for x in resource_tree),
    'active_combat_txt_files': sum(x['path'].startswith('repo/combat/') and x['path'].endswith('.txt') for x in resource_tree),
    'active_tcg_txt_files': sum(x['path'].startswith('repo/tcg/') and x['path'].endswith('.txt') for x in resource_tree),
}
result = {
    'generated_at': datetime.now(timezone.utc).isoformat(),
    'evidence_scope': 'Static local SHA256 file inventory matched to recorded import provenance; no downloaded scripts executed; no game behavior verified.',
    'source': {'url': provenance['source']['url'], 'commit': provenance['source']['revision'], 'checkout': str(SOURCE)},
    'resources': {'url': provenance['scripts']['url'], 'commit': provenance['scripts']['revision'], 'checkout': str(RESOURCES)},
    'import_verification': verification,
    'source_file_inventory': source_tree,
    'summary': summary, 'game_task_modules': modules,
    'game_task_root_files': [str(p.relative_to(SOURCE)) for p in sorted((APP / 'GameTask').glob('*.cs'))],
    'script_bindings': bindings, 'public_surface_declaration_lines': public_surface,
    'execution_contracts': execution_contracts,
    'source_bound_names_missing_from_dts': [b['name'] for b in bindings if b['name'] not in dts_names],
    'source_assets': assets, 'active_resource_file_inventory': active_resources, 'active_js_packages': packages,
    'lexical_api_reference_file_counts': dict(api_file_counts.most_common()),
    'api_scan_limits': 'Lexical scan includes comments/strings; misses aliases, computed members and indirect calls. Counts are not runtime coverage.',
    'native_resource_packages': re.findall(r'PackageReference Include="(BetterGI\.Assets\.[^"]+)" Version="([^"]+)"', read(APP / 'BetterGenshinImpact.csproj')),
}
options.output.parent.mkdir(parents=True, exist_ok=True)
options.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f'JSON: {options.output}')
