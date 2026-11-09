"""Static wiring guard, NOT a Windows UI or behavioral acceptance test."""
from pathlib import Path
import re

source = (Path(__file__).resolve().parents[1] / 'src/lib.rs').read_text(encoding='utf-8')

def body(name):
    found = re.search(r'(?m)^(?:pub(?:\([^)]*\))? )?(async )?fn ' + re.escape(name) + r'\(', source)
    assert found, name + ': function not found'
    tail = source[found.start():]
    end = re.search(r'(?m)^(?:#\[|(?:pub(?:\([^)]*\))? )?(?:async )?fn )', tail[tail.find('{') + 1:])
    return bool(found.group(1)), tail if end is None else tail[:tail.find('{') + 1 + end.start()]

for name in ['open_external', 'scan_model_clis', 'validate_cli_path', 'check_cli_updates', 'ai_cli_steer_supported', 'steer_ai_cli', 'preview_local_file', 'ensure_local_asset_scope']:
    asynchronous, function = body(name)
    assert asynchronous, name + ': blocking invoke must be async'
    assert 'native_background::run_bounded' in function, name + ': missing bounded admission/deadline'

assert 'mod performance;' in source
assert 'performance::report_ui_performance,' in source
assert 'performance::start(app.handle().clone())' in source
assert 'open_external(GITHUB_REPOSITORY_URL.to_string()).await' in source
assert 'message_platforms::shutdown();' not in source, 'shutdown future discarded'
_, runtime = body('ai_cli_runtime')
assert '.join()' not in runtime, 'CLI cleanup still has an unbounded join'
assert 'stream_lane().try_acquire_owned()' in runtime, 'unbounded CLI stream workers'
assert 'join_until(out_handle, drain_deadline)' in runtime
print('PASS static bounded IPC, CLI drain, tray/exit and performance wiring')
