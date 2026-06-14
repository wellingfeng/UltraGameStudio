# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | 日本語 | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

ゲームエンジンでは、コードは作業のごく一部にすぎません。残りはアセットとパイプライン——マテリアル、ブループリント、地形、空、UI、スケルタルアニメーション、パッケージング、パフォーマンスです。FreeUltraCode は Claude Code / Codex / Gemini 系の coding エージェントを、この現実に合わせて作り直したものです。ゲームエンジンの概念を理解し、ゲームに必要なあらゆるアセット（画像、3D モデル、2D スプライトアニメーション、アトラス、音声、リギング、動画）を生成し、ルーチン作業を無料または低コストのチャネルへルーティングして、プレミアム枠を本当に必要な場面に回します。

<p align="center">
  <strong>ワンクリックで Unreal Engine の UMG インターフェース</strong><br>
  <img src="images/game/JMsXEKE.png" alt="FreeUltraCode がワンクリックで Unreal Engine の UMG インターフェースを生成" width="960">
</p>

<p align="center">
  <strong>ワンクリックで 3D モデル生成</strong><br>
  <img src="images/game/noYfqPt.png" alt="FreeUltraCode がワンクリックで 3D モデルを生成" width="960">
</p>

<p align="center">
  <strong>画像・スプライト・メッシュ・音声・リギング・動画——すべてを 1 つの coding エージェントで管理</strong><br>
  <img src="images/game/gmclmLS.png" alt="FreeUltraCode の統合ゲームアセット生成" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="FreeUltraCode のゲームアセットワークフロー" width="960">
</p>

## なぜ FreeUltraCode か

いまや AI はコードの大半を自分で書けるほど優秀です。プログラマーの役割は、意図を伝え、出力を検証し、エージェントをオーケストレーションする方向へ移っています。しかしゲームはコードだけではありません。ゲームエンジンはマテリアル、ブループリント、地形、空、UI、スケルタルアニメーション、パッケージング、パフォーマンス調整であふれており——汎用の coding エージェントはそのほとんどを理解していません。

FreeUltraCode は Claude Code / Codex / Gemini 系のエージェントを、ゲーム開発向けに深くカスタマイズします。

- **ゲームエンジンの言葉を話す。** エージェントはゲーム開発の概念で下準備されており、マテリアル、ブループリント、地形、ライティング、UI（UMG など）、スケルタルアニメーション、ビルド／パッケージング、パフォーマンス最適化について推論できます。
- **ゲームに必要なあらゆるアセットを生成。** 画像、3D モデル、2D スプライトアニメーション、スプライトアトラス、音声、スケルタルリギング、動画を同じ画面で生成し、1 つのエージェントワークフローで管理します。
- **内蔵のゲーム開発エキスパート陣。** テクニカルディレクター、ゲームプレイ／AI／ネットワーク／ツールプログラマー、レベル／エコノミーデザイナー、アート＆オーディオディレクター、QA、リリースマネージャーなど 40 以上の専門ロールが Unity・Unreal・Godot・Web をカバーします。
- **プレミアム枠を肝心な場面に温存。** ルーチン作業は無料・試用・低コストチャネルへ回し、キー・設定・履歴はローカルに保持します。

## できること

### ゲーム開発 Chat

- ゲームプレイのコード、エンジン統合、シェーダー／マテリアルロジック、ビルドスクリプト、バグ調査、リファクタ、テスト、リリースノートを依頼できます。
- Unity・Unreal・Godot・Web エンジンのプロジェクトに対応——エージェントはファイルだけでなくエンジンの概念で推論します。
- ファイルパスを指定したり、ファイルを入力欄へドラッグできます。
- ストリーミング出力、コマンドログ、ファイル参照、要約を 1 つのチャット画面で確認できます。
- 同じセッションで続けて相談できます。

### ゲームアセット生成

ゲームに必要なあらゆる種類のアセットを同じ画面で生成し、プロジェクトに適用してから、再びプログラミングモデルに渡せます——すべて同じ履歴に残ります。各ジェネレーターは設定済みの provider を経由します。

| アセット | 生成物 | モード |
| --- | --- | --- |
| 画像 | コンセプトアート、UI モックアップ、アイコン、ポスター、テクスチャ、参照 | `/image`、`/img`、`/draw`、`/生图` または `/image-mode-start` |
| ComfyUI グラフ | ノードベースで編集可能な画像パイプライン | `/comfyui-mode-start` |
| 2D スプライト | ゲームスプライト、連番フレーム、スプライトシート | `/sprite` または `/sprite-mode-start` |
| 3D モデル | プロップ、キャラクター、シーンメッシュ、ブロックアウト | `/mesh-mode-start`（`/mesh-search` でライブラリ検索） |
| 音楽 | BGM、スコア、音楽クリップ | `/music` または `/music-mode-start` |
| 音声 | ボイスライン、ナレーション | `/speech-mode-start` |
| 動画 | 動画クリップ、モーションアセット | `/video` または `/video-mode-start` |

エージェントはまずプロンプトを磨き、設定済みの provider へ送り、結果をプロンプトと provider 情報とともにチャットに表示します。各モードは対応する `*-mode-end` コマンドで終了できます。

### ゲーム開発エキスパート陣

FreeUltraCode には 40 以上のゲーム開発スペシャリストが内蔵され、タスクに応じてエージェントが自動的に呼び出します。

- **エンジンスペシャリスト**: Unity、Unreal、Godot（GDScript / C# / GDExtension / シェーダー）、Web。
- **プログラミング**: テクニカルディレクター、リード／エンジン／ゲームプレイ／AI／ネットワーク／ツール／UI プログラマー。
- **デザイン**: ゲームプレイ、レベル、エコノミー、ライブオプス、ナラティブデザイナー。
- **アート＆オーディオ**: ディレクターとスペシャリスト、VFX、サウンドデザイン、オーディオディレクション。
- **プロダクション・品質・リリース**: プロデューサー、QA リード／テスター、devops、セキュリティ、ローカライズ、リリースマネージャー。

アクティブなエンジン、council モード、有効にするエキスパートは **Settings** で設定します。

### 無料モデルルーティング

- **20+ のリモートチャネルとローカル runtime**: NVIDIA NIM、OpenRouter、GitHub Models、Hugging Face Router、SambaNova Cloud、Together AI、Google Gemini、DeepSeek、Mistral、Mistral Codestral、OpenCode、Wafer、Kimi、Cerebras、Groq、Fireworks、Z.ai、LLM7、Kilo Gateway、Ollama、LM Studio、llama.cpp。
- **キー不要の実験的ルート**: LLM7 と Kilo Gateway は API キーなしで試せますが、機密ではない coding prompt に限定するのが安全です。
- **公式の無料枠または試用枠**: provider key はアプリ内にローカル保存されます。
- ローカル Rust proxy が Anthropic と OpenAI-compatible プロトコルを変換します。
- Claude Code はチャット UI を変えずに、設定済みの無料チャネル経由で利用できます。
- キー、モデル上書き、ローカルモデル設定は settings で管理できます。

<p align="center">
  <strong>無料チャネルルーティング</strong><br>
  <img src="images/hero-free-channels.ja.png" alt="FreeUltraCode の無料チャネルルーティングのスクリーンショット" width="960">
</p>

現在のプログラミング向けデフォルトモデル:

| チャネル | デフォルトモデル |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### 動的ワークフロー (/ultracode)

複雑な多段階のプログラミングタスクでは、`/ultracode <タスク>` がその場で専用の実行ハーネスを生成し、即座に実行します。ビジュアルキャンバスは不要です。

- 自然言語でタスクを記述すると、プランナーが並列サブエージェント、敵対的検証、受け入れゲートを備えたハーネスを構築します。
- 6 つの内部戦略が自動選択されます：分類実行、ファンアウト合成、敵対的検証、生成フィルタ、トーナメント、完了までのループ。
- すべての実行は `.fuc-run/<run-id>/` 以下に完全記録され、タスク台帳、イベント、判定、最終結果が保存されます。
- デスクトップアプリまたは CLI から実行：`fuc ultracode "<タスク>" --json --interactive --cwd <workspace>`。
- 設定不要 — ローカルの `claude` CLI ログイン情報を再利用します。

#### Free Auto — マルチチャンネル自動切替

**Auto** チャンネル（Channel メニューの `freecc:auto`）は、各リクエストを現在利用可能な最適な無料チャンネルに自動ルーティングします。手動切替不要。

- 設定済みの全無料チャンネルを巡回し、レート制限（429）やアップストリームエラー（5xx）が発生したチャンネルを自動スキップ。
- チャンネルごとのクールダウンをバックオフ付きで追跡：エラー後、一時停止してから再試行。
- オプションのモデル上書きをサポートし、どのチャンネルが処理しても全リクエストが同一モデルを使用。
- 全チャンネルが枯渇した場合、障害ログ付きの503を返し、停止原因を診断可能。

#### マルチプロバイダーチェーン：DeepSeek → CodeX

`/ultracode` 使用時、ハーネスは計画ステップ間で複数プロバイダーを自動的に連結できます。典型的なパターン：DeepSeek が低コストで応答草案を生成し、CodeX が引き継いで最終品質に仕上げます。

- **動的ハーネス計画**はステップごとの `model` 上書きをサポート — ブレインストーミング/分類ステップに DeepSeek、実装/検証ステップに CodeX/Gemini を割当て。
- **cc-switch 互換性**：FreeUltraCode は `cc-switch` CLI 設定を読み取り、Claude Code ルーティング用に設定済みの全プロバイダーが即座に ultracode ステップで利用可能。
- **ファンアウト合成**戦略は DeepSeek ワーカーを独立サブタスクに並列化し、コンセンサスゲート（CodeX）が結果を合成・検証。

#### 速度を考慮したチャンネル選択

無料プロキシの Auto チャンネルは、リアルタイムの可用性シグナルに基づいてチャンネルを優先します：

- **レート制限認識**：429 を返すチャンネルは30秒以上クールダウンし、飽和したアップストリームへの無駄な試行を防止。
- **エラー時の高速失敗**：再試行不可能なエラー（4xx 認証失敗、5xx アップストリーム障害）はチャンネルごとにクールダウン追跡。Auto ルーターがスキップ。
- **接続時間予算**：各チャンネル試行はアップストリームのタイムアウトに従う。Auto ルーターは単一の低速アップストリームでブロックしない。
- **応答性による自然順序**：成功したチャンネルはクールダウン記録がなく自然に優先。エラーチャンネルは候補リスト末尾に後回し。

これらの機能により、個別の無料プロバイダーが低速、レート制限中、または一時的に利用不可でも `/ultracode` ハーネス実行は高い回復力を維持します。

## クイックスタート

```bash
cd app
npm install
npm run dev
```

デスクトップアプリを起動:

```bash
cd app
npm run desktop
```

本番パッケージを作成:

```bash
cd app
npm run package
```

## 基本的な使い方

### 無料チャネルを登録する

1. 下部の **Channel** メニューを開き、警告マーク付きの無料チャネルを選びます。例: **Free · OpenRouter**。

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Channel メニューで未設定の無料チャネルを選ぶ" width="960">
</p>

2. API key ダイアログで **Open registration site** をクリックします。

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="provider の登録サイトを開く" width="960">
</p>

3. provider のページで新しい API key を作成し、コピーします。

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="provider API key を作成する" width="960">
</p>

4. FreeUltraCode に key を貼り付け、**Save and Use** をクリックします。保存後、警告マークが消えます。

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="設定済みの無料チャネル" width="960">
</p>

5. **Settings** -> **Channels** -> **Free Channels** から全チャネルをまとめて管理できます。

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="settings で無料チャネルを管理する" width="960">
</p>

チャネルが ready になったら、下部の入力欄からそのルートでチャットできます。

### ゲームアセットを生成する

アセットモードは、同じセッション履歴を保ったまま Chat composer をアセット生成画面に切り替えます。UI モックアップ、アイコン、テクスチャ、スプライト、3D モデル、音声、動画を作ってからコード作業へ戻るときに便利です。以下は画像モードの例ですが、スプライト・メッシュ・音楽・音声・動画モードもそれぞれの `*-mode-start` コマンドで同様に動きます。

1. **Settings** -> **Images**（または対応するアセットのセクション）を開き、既定のプロバイダーを選び、API key、Account ID、Base URL、またはローカル ComfyUI endpoint を設定します。
2. チャットセッションで `/image-mode-start` と入力します。モードを開始して同時に生成することもできます。

```text
/image-mode-start ファンタジーダンジョン向けの様式化した石壁テクスチャ、タイル可能、1024x1024
```

3. モード中は、通常のメッセージがコード編集ではなくアセット生成になります。**Channel** セレクターはアセットプロバイダーに切り替わります。
4. 作りたいアセットを説明します。FreeUltraCode はまずプログラミングモデルで prompt を整え、その後設定済みプロバイダーへ送信します。

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="アセットモードは同じ FreeUltraCode セッション内で素材を生成します" width="720">
</p>

5. `/image-mode-end` を送ると、プログラミング用の channel と model に戻ります。常駐モードにせず 1 つだけ生成する場合は、`/image`、`/img`、`/draw`、`/生图`、`/sprite`、`/music`、`/video` の後に prompt を続けます。

## 仕組み

```text
ユーザーの依頼
    |
    v
Chat composer
    |
    +--> selected runtime / channel / permission / workspace
             |
             +--> provider API, local CLI, or local free-channel proxy
                        |
                        +--> streamed output, tool log, and chat history
```

## 技術スタック

| 領域 | 技術 |
| --- | --- |
| Desktop shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS variables |
| Icons | lucide-react |
| Provider routing | Claude Code, Codex, Gemini, extensible provider settings |
| Free-channel proxy | Rust `tiny_http` + `ureq`, Anthropic/OpenAI protocol translation |

## プロジェクト構成

```text
app/
  src/
    components/  共通 UI コンポーネント
    lib/         provider 設定、無料チャネル routing、アセット生成（画像/スプライト/3D/音楽/音声/動画/ComfyUI）、ゲーム開発エキスパート陣、永続化
    panels/      Sidebar、chat dock、settings、scheduling UI
    store/       Zustand state とローカル履歴
  src-tauri/
    src/
      free_proxy.rs    Rust reverse proxy + Anthropic/OpenAI translation
      lib.rs           Tauri commands, filesystem/history bridge
  doc/                 チュートリアル、ローカライズ README、スクリーンショット
```

## ドキュメント

- [無料チャネル登録ガイド 中国語](register-free-channel.md)
- [English README](../../README.md)

## 開発

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## コミュニティ

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## ライセンス

ライセンスはまだ指定されていません。
