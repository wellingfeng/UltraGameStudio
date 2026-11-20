use super::{
    dap,
    unreal::{canonical, hidden, Unreal},
    Action, ProjectInfo,
};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const CONFIG: &str = ".ultragamestudio/project-debug.json";

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    profile: Action,
    editor: Option<PathBuf>,
    adapter: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    schema_version: u8,
    engine: String,
    project: PathBuf,
    selection: Selection,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    engine: String,
    project: PathBuf,
    version: Option<String>,
    issue: Option<String>,
    launch_error: String,
    profiles: Vec<Action>,
    editors: Vec<PathBuf>,
    adapters: Vec<PathBuf>,
    current: Option<Selection>,
}

pub(super) struct Project {
    root: PathBuf,
    detection: crate::ProjectEngineDetection,
    marker: PathBuf,
    saved: Result<Option<Saved>, String>,
    editors: Vec<PathBuf>,
    adapter: Result<Option<dap::Adapter>, String>,
    pub unreal: Option<Unreal>,
}

impl Project {
    pub fn detect(root: &Path) -> Self {
        let detection = crate::detect_project_engine(root);
        let marker = detection
            .project_file
            .as_ref()
            .map(PathBuf::from)
            .and_then(|path| path.strip_prefix(root).ok().map(Path::to_owned))
            .unwrap_or_default();
        let saved = match fs::read(root.join(CONFIG)) {
            Ok(bytes) => serde_json::from_slice::<Saved>(&bytes)
                .map_err(|_| "项目调试配置格式无效。".to_owned())
                .and_then(|saved| {
                    if saved.schema_version == 1
                        && saved.engine == detection.engine
                        && saved.project == marker
                    {
                        Ok(Some(saved))
                    } else {
                        Err("项目调试配置与当前项目或引擎不匹配。".into())
                    }
                }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("无法读取项目调试配置：{error}")),
        };
        let unreal =
            (cfg!(windows) && detection.engine == "unreal" && !marker.as_os_str().is_empty())
                .then(|| Unreal::detect(root, root.join(&marker)));
        let editors = match detection.engine.as_str() {
            "unreal" => unreal
                .as_ref()
                .and_then(Unreal::editor)
                .into_iter()
                .collect(),
            "unity" if cfg!(windows) => unity_editors(detection.version.as_deref()),
            "godot" if cfg!(windows) => godot_editors(root),
            _ => Vec::new(),
        };
        let adapter = if let Some(unreal) = &unreal {
            dap::availability(unreal).map(Some)
        } else {
            Ok(None)
        };
        Self {
            root: root.to_owned(),
            detection,
            marker,
            saved,
            editors,
            adapter,
            unreal,
        }
    }

    fn profiles(&self) -> &[Action] {
        match self.detection.engine.as_str() {
            "unreal" => &[
                Action::Pie,
                Action::Editor,
                Action::Game,
                Action::DebugEditor,
                Action::DebugGame,
                Action::Attach,
            ],
            "unity" => &[Action::DebugEditor, Action::Editor],
            "godot" => &[Action::DebugGame, Action::Game, Action::Editor],
            _ => &[],
        }
    }

    fn selection(&self) -> Option<&Selection> {
        self.saved
            .as_ref()
            .ok()?
            .as_ref()
            .map(|saved| &saved.selection)
    }

    pub fn editor(&self) -> Option<&Path> {
        match self
            .selection()
            .and_then(|selection| selection.editor.as_ref())
        {
            Some(editor) => self
                .editors
                .iter()
                .find(|candidate| *candidate == editor)
                .map(PathBuf::as_path),
            None => self.editors.first().map(PathBuf::as_path),
        }
    }

    pub fn is_godot(&self) -> bool {
        self.detection.engine == "godot"
    }
    pub fn is_unity(&self) -> bool {
        self.detection.engine == "unity"
    }

    fn pie(&self) -> bool {
        self.unreal.as_ref().is_some_and(Unreal::pie_available)
    }

    fn adapter(&self) -> Option<&dap::Adapter> {
        self.adapter.as_ref().ok()?.as_ref()
    }

    fn debugger(&self) -> bool {
        if self.editor().is_none() {
            return false;
        }
        match self.detection.engine.as_str() {
            "unreal" => self.adapter().is_some_and(|adapter| {
                self.selection()
                    .and_then(|selection| selection.adapter.as_ref())
                    .is_none_or(|selected| *selected == adapter.path)
            }),
            "unity" => true,
            "godot" => godot_has_main_scene(&self.root),
            _ => false,
        }
    }

    fn issue(&self) -> Option<String> {
        if let Err(error) = &self.saved {
            return Some(error.clone());
        }
        if self.editor().is_none() {
            return Some(match self.detection.engine.as_str() {
                "unreal" => "未找到项目关联的 Unreal Editor。".into(),
                "unity" => format!(
                    "未找到项目要求的 Unity Editor {}。",
                    self.detection
                        .version
                        .as_deref()
                        .unwrap_or("版本（ProjectVersion.txt 缺失）")
                ),
                "godot" => "未找到兼容项目且支持 GDScript 调试的 Godot 编辑器。".into(),
                _ => "当前引擎暂无调试适配。".into(),
            });
        }
        if !self.debugger() {
            return Some(if self.is_godot() {
                "请在项目中设置有效的 Godot 主场景。".into()
            } else {
                self.adapter
                    .as_ref()
                    .err()
                    .cloned()
                    .unwrap_or_else(|| "项目配置的调试适配器已不可用。".into())
            });
        }
        let profile = self.profile();
        if profile == Some(Action::Pie) && !self.pie() {
            return Some("当前 UE 项目未配置可用的 Python Remote Execution，无法启动 PIE。".into());
        }
        if profile == Some(Action::Attach) && !self.adapter().is_some_and(|adapter| adapter.attach)
        {
            return Some(dap::ATTACH_HINT.into());
        }
        None
    }

    fn profile(&self) -> Option<Action> {
        self.selection()
            .map(|selection| selection.profile)
            .filter(|profile| self.profiles().contains(profile))
            .or_else(|| self.profiles().first().copied())
    }

    pub fn info(&self) -> ProjectInfo {
        ProjectInfo {
            engine: self.detection.engine.clone(),
            project: self.detection.project_file.clone(),
            editor: self.editor().map(Path::to_owned),
            name: if self.is_unity() || self.is_godot() {
                self.root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            } else {
                None
            },
            target: self
                .unreal
                .as_ref()
                .and_then(|project| project.target.clone()),
            installed: self.editor().is_some(),
            build: self
                .unreal
                .as_ref()
                .is_some_and(|project| project.target.is_some() && project.ubt().is_some()),
            debugger: self.debugger(),
            attach: self.debugger() && self.adapter().is_some_and(|adapter| adapter.attach),
            pie: self.pie(),
            profile: self.profile(),
            issue: self.issue(),
        }
    }

    pub fn setup(&self, launch_error: String) -> Setup {
        Setup {
            engine: self.detection.engine.clone(),
            project: self.marker.clone(),
            version: self.detection.version.clone(),
            issue: self.issue(),
            launch_error,
            profiles: self.profiles().to_vec(),
            editors: self.editors.clone(),
            adapters: self
                .adapter()
                .map(|adapter| adapter.path.clone())
                .into_iter()
                .collect(),
            current: self.selection().cloned(),
        }
    }

    fn save(&self, selection: Selection) -> Result<(), String> {
        if !self.profiles().contains(&selection.profile) {
            return Err("所选配置不适用于当前项目引擎。".into());
        }
        self.local_directory("")?;
        let path = self.root.join(CONFIG);
        let saved = Saved {
            schema_version: 1,
            engine: self.detection.engine.clone(),
            project: self.marker.clone(),
            selection,
        };
        let data = serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string())?;
        crate::atomic_write(&path, &data).map_err(|error| format!("无法保存项目调试配置：{error}"))
    }

    pub fn save_profile(&self, profile: Action) -> Result<(), String> {
        let mut selection = self.selection().cloned().unwrap_or(Selection {
            profile,
            editor: None,
            adapter: None,
        });
        selection.profile = profile;
        self.save(selection)
    }

    pub fn apply(&self, selection: Selection) -> Result<(), String> {
        if !selection
            .editor
            .as_ref()
            .is_some_and(|editor| self.editors.contains(editor))
        {
            return Err("自动配置未选中当前项目可用的编辑器。".into());
        }
        if self.unreal.is_some()
            && !self
                .adapter()
                .is_some_and(|adapter| selection.adapter.as_ref() == Some(&adapter.path))
        {
            return Err(self
                .adapter
                .as_ref()
                .err()
                .cloned()
                .unwrap_or_else(|| "自动配置未选中可用的 LLVM 调试适配器。".into()));
        }
        if self.unreal.is_none() && selection.adapter.is_some() {
            return Err("当前引擎使用内置调试协议，无需外部适配器。".into());
        }
        if self.is_godot() && !godot_has_main_scene(&self.root) {
            return Err("请在项目中设置有效的 Godot 主场景。".into());
        }
        if selection.profile == Action::Pie && !self.pie() {
            return Err("当前 UE 项目未配置可用的 Python Remote Execution。".into());
        }
        if selection.profile == Action::Attach
            && !self.adapter().is_some_and(|adapter| adapter.attach)
        {
            return Err(dap::ATTACH_HINT.into());
        }
        self.save(selection)
    }

    pub fn command(&self, game: bool) -> Result<Command, String> {
        let editor = self.editor().ok_or("项目编辑器不可用。")?;
        let mut command = Command::new(editor);
        command.current_dir(&self.root);
        if self.is_unity() {
            command.arg("-projectPath").arg(&self.root);
        } else if self.is_godot() {
            command.arg("--path").arg(&self.root);
            if !game {
                command.arg("--editor");
            } else if !godot_has_main_scene(&self.root) {
                return Err("请在项目中设置有效的 Godot 主场景。".into());
            }
        } else {
            return Err("当前引擎暂无运行适配。".into());
        }
        Ok(command)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn local_directory(&self, subdirectory: &str) -> Result<PathBuf, String> {
        let directory = self.root.join(".ultragamestudio").join(subdirectory);
        let parent = self.root.join(".ultragamestudio");
        if parent.exists() && !canonical(&parent).is_ok_and(|path| path.starts_with(&self.root)) {
            return Err("项目调试配置目录不在工作区内。".into());
        }
        fs::create_dir_all(&directory).map_err(|error| format!("无法创建项目调试目录：{error}"))?;
        if !canonical(&directory).is_ok_and(|path| path.starts_with(&self.root)) {
            return Err("项目调试目录不在工作区内。".into());
        }
        Ok(directory)
    }
}

fn executable_paths(env_key: &str, file_names: &[&str]) -> Vec<PathBuf> {
    env::var_os(env_key)
        .map(PathBuf::from)
        .into_iter()
        .chain(env::var_os("PATH").into_iter().flat_map(|paths| {
            env::split_paths(&paths)
                .flat_map(|path| file_names.iter().map(move |name| path.join(name)))
                .collect::<Vec<_>>()
        }))
        .filter(|path| path.is_absolute() && path.is_file())
        .collect()
}

fn distinct(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in paths {
        if let Ok(path) = canonical(&path) {
            if path.is_file() && !result.contains(&path) {
                result.push(path);
            }
        }
    }
    result
}

#[cfg(windows)]
fn unity_file_version(path: &Path) -> Option<String> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    let encoded: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let size = unsafe { GetFileVersionInfoSizeW(encoded.as_ptr(), ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(encoded.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = |key: &str| {
        let key: Vec<_> = key.encode_utf16().chain(Some(0)).collect();
        let mut value = ptr::null_mut();
        let mut size = 0;
        (unsafe { VerQueryValueW(data.as_ptr().cast(), key.as_ptr(), &mut value, &mut size) } != 0
            && !value.is_null()
            && size > 0)
            .then_some((value, size as usize))
    };
    let (translation, size) = query("\\VarFileInfo\\Translation")?;
    let translations = unsafe { std::slice::from_raw_parts(translation.cast::<u8>(), size) };
    for item in translations.chunks_exact(4) {
        let language = u16::from_le_bytes([item[0], item[1]]);
        let code_page = u16::from_le_bytes([item[2], item[3]]);
        let key = format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\ProductVersion");
        if let Some((value, size)) = query(&key) {
            let units =
                unsafe { std::slice::from_raw_parts(value.cast::<u16>(), size.saturating_sub(1)) };
            return Some(String::from_utf16_lossy(units));
        }
    }
    None
}

#[cfg(not(windows))]
fn unity_file_version(_: &Path) -> Option<String> {
    None
}

fn unity_editors(version: Option<&str>) -> Vec<PathBuf> {
    let Some(version) = version.filter(|version| {
        !version.is_empty()
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.')
    }) else {
        return Vec::new();
    };
    let hub_root = env::var_os("APPDATA").and_then(|path| {
        let path = PathBuf::from(path).join("UnityHub/secondaryInstallPath.json");
        serde_json::from_str::<PathBuf>(&crate::project_read_small_text(&path, 8192)?).ok()
    });
    let locations = executable_paths("UGS_UNITY_EDITOR", &["Unity.exe"])
        .into_iter()
        .chain(
            hub_root
                .filter(|path| path.is_absolute())
                .map(|path| path.join(version).join("Editor/Unity.exe")),
        )
        .chain(env::var_os("ProgramFiles").map(|path| {
            PathBuf::from(path)
                .join("Unity/Hub/Editor")
                .join(version)
                .join("Editor/Unity.exe")
        }))
        .chain(
            env::var_os("ProgramFiles")
                .map(|path| PathBuf::from(path).join("Unity/Editor/Unity.exe")),
        )
        .chain(env::var_os("LOCALAPPDATA").map(|path| {
            PathBuf::from(path)
                .join("Programs/Unity/Hub/Editor")
                .join(version)
                .join("Editor/Unity.exe")
        }));
    distinct(locations)
        .into_iter()
        .filter(|editor| {
            let Some(folder) = editor.parent() else {
                return false;
            };
            if !folder
                .join("Data/MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll")
                .is_file()
            {
                return false;
            }
            if let Some(actual) = unity_file_version(editor) {
                let token = actual
                    .split(|c: char| c.is_whitespace() || c == '_')
                    .next()
                    .unwrap_or_default();
                if token.chars().any(|c| c.is_ascii_alphabetic()) {
                    return token == version;
                }
            }
            folder
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == version)
        })
        .collect()
}

fn godot_editors(root: &Path) -> Vec<PathBuf> {
    let Some(text) = crate::project_read_small_text(&root.join("project.godot"), 256 * 1024) else {
        return Vec::new();
    };
    if text.lines().any(|line| {
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        key.trim().trim_start_matches('\u{feff}') == "config_version"
            && value.trim().parse::<u16>().is_ok_and(|version| version < 5)
    }) {
        return Vec::new();
    }
    let minimum = text.lines().find_map(|line| {
        let (key, features) = line.split_once('=')?;
        (key.trim() == "config/features").then_some(())?;
        features.split('"').find_map(version_pair)
    });
    let installed_dirs = env::var_os("ProgramFiles")
        .map(|path| PathBuf::from(path).join("Godot"))
        .into_iter()
        .chain(env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("Programs/Godot")));
    let locations = executable_paths("UGS_GODOT_EDITOR", &["godot.exe", "godot4.exe"])
        .into_iter()
        .chain(
            installed_dirs
                .flat_map(|dir| fs::read_dir(dir).into_iter().flatten().flatten())
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    (name.starts_with("godot")
                        && name.ends_with(".exe")
                        && !name.ends_with("_console.exe"))
                    .then(|| entry.path())
                }),
        );
    distinct(locations)
        .into_iter()
        .filter(|path| {
            let help = hidden(path).arg("--help").stdin(Stdio::null()).output();
            help.is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("--dap-port")
            }) && hidden(path)
                .arg("--version")
                .stdin(Stdio::null())
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| version_pair(String::from_utf8_lossy(&output.stdout).trim()))
                .is_some_and(|version| {
                    version.0 == 4
                        && minimum
                            .is_none_or(|minimum| version.0 == minimum.0 && version.1 >= minimum.1)
                })
        })
        .collect()
}

fn version_pair(value: &str) -> Option<(u32, u32)> {
    let mut parts = value.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn godot_has_main_scene(root: &Path) -> bool {
    crate::project_read_small_text(&root.join("project.godot"), 256 * 1024)
        .and_then(|text| {
            text.lines().find_map(|line| {
                let (key, value) = line.split_once('=')?;
                (key.trim() == "run/main_scene").then(|| value.trim().trim_matches('"').to_owned())
            })
        })
        .is_some_and(|scene| {
            scene
                .strip_prefix("res://")
                .is_some_and(|path| root.join(path).is_file())
                || scene
                    .strip_prefix("uid://")
                    .is_some_and(|uid| !uid.is_empty())
        })
}
