import json
import os
import re
import socket
import sys
import time

module, project, action = sys.argv[1:4]
expected_pid = int(sys.argv[4]) if len(sys.argv) > 4 else 0
sys.path.insert(0, module)
import remote_execution


def normal(path):
    return os.path.normcase(os.path.realpath(path))


root = os.path.dirname(project)
project_name = os.path.splitext(os.path.basename(project))[0]
config = remote_execution.RemoteExecutionConfig()
# Reuse the project's multicast port while keeping the command channel local.
ini = os.path.join(root, 'Config', 'DefaultEngine.ini')
if os.path.isfile(ini):
    with open(ini, encoding='utf-8-sig', errors='replace') as file:
        match = re.search(r'^\s*RemoteExecutionMulticastGroupEndpoint\s*=\s*([\d.]+):(\d+)', file.read(), re.M)
    if match:
        config.multicast_group_endpoint = (match[1], int(match[2]))
with socket.socket() as port:
    port.bind(('127.0.0.1', 0))
    config.command_endpoint = port.getsockname()

script = '''
import json, os, unreal
root = os.path.normcase(os.path.realpath(unreal.SystemLibrary.get_project_directory()))
if (root != EXPECTED_ROOT or unreal.SystemLibrary.get_game_name().lower() != EXPECTED_NAME
        or (EXPECTED_PID and os.getpid() != EXPECTED_PID)):
    raise RuntimeError('编辑器项目与当前工作区不匹配')
editor = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
playing = editor.is_in_play_in_editor()
if ACTION == 'start' and not playing:
    editor.editor_request_begin_play()
elif ACTION == 'stop' and playing:
    editor.editor_request_end_play()
elif ACTION == 'live':
    unreal.SystemLibrary.execute_console_command(None, 'LiveCoding.Compile')
unreal.log('UGS_RUN_STATE=' + json.dumps({'pid': os.getpid(), 'playing': playing}))
'''


def run():
    verb = 'start' if action == 'wait-start' else action
    deadline = time.monotonic() + (150 if action == 'wait-start' else 5)
    connection = remote_execution.RemoteExecution(config)
    try:
        connection.start()
        while True:
            nodes = [node for node in connection.remote_nodes
                     if node.get('project_root') and normal(node['project_root']) == normal(root)
                     and node.get('project_name', '').lower() == project_name.lower()]
            if len(nodes) > 1:
                raise RuntimeError('同一项目有多个编辑器实例，无法唯一定位 PIE。')
            if nodes:
                break
            if time.monotonic() >= deadline:
                return {'connected': False}
            time.sleep(0.15)

        connection.open_command_connection(nodes[0]['node_id'])
        command = 'EXPECTED_ROOT = %r\nEXPECTED_NAME = %r\nEXPECTED_PID = %d\nACTION = %r\n' % (
            normal(root), project_name.lower(), expected_pid, verb)
        result = connection.run_command(command + script, raise_on_failure=True)
        for entry in result.get('output', []):
            marker = 'UGS_RUN_STATE='
            if marker in entry['output']:
                return dict(json.loads(entry['output'].split(marker, 1)[1]), connected=True)
        raise RuntimeError('编辑器未返回 PIE 状态。')
    finally:
        connection.stop()


try:
    print(json.dumps(run()), flush=True)
except Exception as error:
    print(json.dumps({'error': str(error)}), flush=True)
    sys.exit(1)
