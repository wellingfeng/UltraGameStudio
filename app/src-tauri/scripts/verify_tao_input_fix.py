"""Verify the *resolved* Tao source, not the version printed in Cargo.toml.
Run from src-tauri: python scripts/verify_tao_input_fix.py
This source-boundary guard is not a substitute for live Windows/IME testing.
"""
import json
from pathlib import Path
import subprocess

metadata = json.loads(subprocess.check_output(
    ['cargo', 'metadata', '--format-version', '1', '--locked'], text=True))
tao = [p for p in metadata['packages'] if p['name'] == 'tao']
assert len(tao) == 1, f'expected exactly one resolved Tao, got {len(tao)}'
p = tao[0]
root = Path(p['manifest_path']).parent / 'src/platform_impl/windows'
keyboard = (root / 'keyboard.rs').read_text(encoding='utf-8')
ime = (root / 'minimal_ime.rs').read_text(encoding='utf-8')
event = (root / 'event_loop.rs').read_text(encoding='utf-8')
print(json.dumps({k: p[k] for k in ['id', 'version', 'source', 'manifest_path']}, indent=2), flush=True)
assert 'PeekMessageW(' not in keyboard, 'keyboard builder still calls reentrant PeekMessageW while its caller holds KEY_EVENT_BUILDERS'
assert 'PeekMessageW(' not in ime, 'IME processing still peeks while window_state is locked'
assert 'let next_key_message = next_key_message_for_keyboard(window, msg, wparam);' in event
assert event.index('let next_key_message = next_key_message_for_keyboard(window, msg, wparam);') < event.index('KEY_EVENT_BUILDERS.lock()', event.index('let next_key_message ='))
assert 'let more_char_coming = more_ime_char_coming(window, msg);' in event
print('PASS: keyboard and IME peeks precede input locks; no event-dropping workaround')
