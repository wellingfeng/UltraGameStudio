use serde_json::Value;
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) struct Unreal {
    pub project: PathBuf,
    pub engine: Option<PathBuf>,
    pub target: Option<String>,
    build_flags: Vec<String>,
}

pub(super) fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    path.canonicalize()
        .map(|path| PathBuf::from(crate::project_path_display(&path)))
}

fn is_engine(path: &Path) -> bool {
    path.join("Binaries/Win64/UnrealEditor.exe").is_file()
}

fn read_json(path: &Path) -> Option<Value> {
    let text = crate::project_read_small_text(path, 1024 * 1024)?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

#[cfg(windows)]
fn registered_engine(association: &str) -> Option<PathBuf> {
    if association.is_empty() {
        return None;
    }
    for (key, value) in [
        (
            "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds".to_owned(),
            association,
        ),
        (
            format!("HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\{association}"),
            "InstalledDirectory",
        ),
    ] {
        let output = hidden("reg.exe")
            .args(["query", &key, "/v", value])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let output = String::from_utf8_lossy(&output.stdout);
        if let Some(path) = output
            .lines()
            .find_map(|line| line.split_once("REG_SZ").map(|(_, path)| path.trim()))
        {
            let engine = PathBuf::from(path).join("Engine");
            if is_engine(&engine) {
                return Some(engine);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn registered_engine(_: &str) -> Option<PathBuf> {
    None
}

impl Unreal {
    pub fn detect(root: &Path, project: PathBuf) -> Self {
        let data = read_json(&project);
        let association = data
            .as_ref()
            .and_then(|data| data["EngineAssociation"].as_str())
            .unwrap_or_default();
        let engine = registered_engine(association).or_else(|| {
            root.ancestors()
                .take(4)
                .map(|parent| parent.join("Engine"))
                .find(|engine| is_engine(engine))
        });
        let mut targets: Vec<_> = fs::read_dir(root.join("Source"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let target = name.strip_suffix(".Target.cs")?;
                let source = crate::project_read_small_text(&entry.path(), 256 * 1024)?;
                (source.contains("TargetType.Editor")
                    && target
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_'))
                .then(|| target.to_owned())
            })
            .collect();
        targets.sort();
        let default_target = format!(
            "{}Editor",
            project.file_stem().unwrap_or_default().to_string_lossy()
        );
        let target = targets
            .iter()
            .find(|target| **target == default_target)
            .cloned()
            .or_else(|| targets.into_iter().next());
        let build_flags = read_json(&root.join(".vscode/tasks.json"))
            .and_then(|data| {
                data["tasks"].as_array()?.iter().find_map(|task| {
                    let args = task["args"].as_array()?;
                    let command = task["command"].as_str()?.to_ascii_lowercase();
                    if !command.ends_with("build.bat")
                        || !args.iter().any(|arg| arg.as_str() == target.as_deref())
                        || !args.iter().any(|arg| arg == "Development")
                    {
                        return None;
                    }
                    Some(
                        args.iter()
                            .filter_map(Value::as_str)
                            .filter(|arg| {
                                matches!(
                                    *arg,
                                    "-NoSNDBS"
                                        | "-NoXGE"
                                        | "-Compiler=Clang"
                                        | "-Compiler=VisualStudio2022"
                                )
                            })
                            .map(str::to_owned)
                            .collect(),
                    )
                })
            })
            .unwrap_or_default();
        Self {
            project,
            engine,
            target,
            build_flags,
        }
    }

    pub fn root(&self) -> &Path {
        self.project.parent().expect("project file has a parent")
    }

    pub fn editor(&self) -> Option<PathBuf> {
        Some(
            self.engine
                .as_ref()?
                .join("Binaries/Win64/UnrealEditor.exe"),
        )
    }

    pub fn arguments(&self, game: bool) -> Vec<String> {
        let mut args = vec![
            self.project.to_string_lossy().into_owned(),
            "-skipcompile".into(),
        ];
        if game {
            args.extend(["-game", "-windowed", "-ResX=1920", "-ResY=1080"].map(str::to_owned));
        }
        args
    }

    pub fn ubt(&self) -> Option<PathBuf> {
        let path = self
            .engine
            .as_ref()?
            .join("Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe");
        path.is_file().then_some(path)
    }

    pub fn build_command(&self) -> Result<Command, String> {
        let mut command = hidden(
            self.ubt()
                .ok_or("找不到 UnrealBuildTool.exe，请检查关联引擎。")?,
        );
        let target = self
            .target
            .as_deref()
            .ok_or("项目没有可编译的 C++ 编辑器目标。")?;
        command
            .current_dir(self.root())
            .args([target, "Win64", "Development", "-WaitMutex", "-UTF8Output"])
            .arg(format!("-Project={}", self.project.display()))
            .args(&self.build_flags);
        Ok(command)
    }

    pub fn remote_command(
        &self,
        action: &str,
        expected_pid: Option<u32>,
    ) -> Result<Command, String> {
        let engine = self.engine.as_ref().ok_or("找不到关联的 Unreal Engine。")?;
        let python = engine.join("Binaries/ThirdParty/Python3/Win64/python.exe");
        let module = engine.join("Plugins/Experimental/PythonScriptPlugin/Content/Python");
        if !python.is_file() || !module.join("remote_execution.py").is_file() {
            return Err("关联引擎缺少 Unreal Python Remote Execution。".into());
        }
        Ok({
            let mut command = hidden(python);
            command
                .env("PYTHONIOENCODING", "utf-8")
                .args(["-I", "-B", "-c", include_str!("ue_editor.py")])
                .arg(module)
                .arg(&self.project)
                .arg(action)
                .arg(expected_pid.unwrap_or(0).to_string());
            command
        })
    }

    pub fn pie_available(&self) -> bool {
        if self.remote_command("status", None).is_err() {
            return false;
        }
        if read_json(&self.project).and_then(|data| {
            data["Plugins"]
                .as_array()?
                .iter()
                .find(|plugin| plugin["Name"] == "PythonScriptPlugin")?["Enabled"]
                .as_bool()
        }) == Some(false)
        {
            return false;
        }
        [
            "Config/DefaultEngine.ini",
            "Config/Windows/WindowsEngine.ini",
            "Saved/Config/WindowsEditor/Engine.ini",
        ]
        .into_iter()
        .rev()
        .filter_map(|path| {
            let text = crate::project_read_small_text(&self.root().join(path), 4 * 1024 * 1024)?;
            let mut section = false;
            text.lines()
                .filter_map(|line| {
                    let line = line.trim().trim_start_matches('\u{feff}');
                    if line.starts_with('[') {
                        section = line.eq_ignore_ascii_case(
                            "[/Script/PythonScriptPlugin.PythonScriptPluginSettings]",
                        );
                    }
                    let (key, value) = line.split_once('=')?;
                    (section && key.trim().eq_ignore_ascii_case("bRemoteExecution"))
                        .then(|| value.trim().eq_ignore_ascii_case("true"))
                })
                .last()
        })
        .next()
        .unwrap_or(false)
    }
}

pub(super) fn hidden(executable: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}
