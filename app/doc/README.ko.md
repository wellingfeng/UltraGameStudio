# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | 한국어 | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

모든 프로그래밍 작업에 가장 비싼 모델 할당량을 쓸 필요는 없습니다. FreeUltraCode는 Claude Code, Codex, Gemini, 무료 채널, 로컬 모델을 하나의 로컬 채팅 화면에 모읍니다. 탐색과 반복 작업은 저렴한 모델로 처리하고, 중요한 판단은 더 안정적인 모델에 맡길 수 있습니다.

<p align="center">
  <strong>무료 채널 라우팅</strong><br>
  <img src="images/hero-free-channels.ko.png" alt="FreeUltraCode 무료 채널 라우팅 스크린샷" width="960">
</p>

## FreeUltraCode가 필요한 이유

코딩 에이전트는 유용하지만 프리미엄 모델 할당량은 빠르게 줄어듭니다. FreeUltraCode는 채팅 경험을 로컬에 두고, 충분한 경우 무료, 체험 크레딧, 저비용 채널로 요청을 쉽게 보낼 수 있게 합니다.

- GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio, llama.cpp를 사용할 수 있습니다.
- API 키와 provider 설정은 사용자 컴퓨터에 저장됩니다.
- runtime, channel, permission mode, workspace를 채팅 입력 영역에서 바로 바꿀 수 있습니다.
- 채팅 기록, 즐겨찾기, 예약 prompt, workspace context를 로컬에 보관합니다.
- 하드웨어가 지원하면 로컬 모델은 API 키 없이 사용할 수 있습니다.

## 주요 기능

### 프로그래밍 Chat

- 코드 수정, 버그 조사, 리팩터링, 테스트, 릴리스 노트, 문서 작성을 요청할 수 있습니다.
- 파일 경로를 붙이거나 파일을 입력창에 드래그할 수 있습니다.
- 스트리밍 응답, 명령 로그, 파일 참조, 요약을 한 채팅 화면에서 확인할 수 있습니다.
- 같은 세션에서 후속 요청을 이어갈 수 있습니다.

### 무료 모델 라우팅

- **20+ 원격 채널과 로컬 runtime**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, 그리고 Ollama, LM Studio, llama.cpp.
- **키 없는 실험 채널**: LLM7과 Kilo Gateway는 API 키 없이 테스트할 수 있지만, 민감하지 않은 코딩 prompt에만 쓰는 것이 좋습니다.
- **공식 무료 또는 체험 크레딧 채널**: provider key는 앱에 로컬로 저장됩니다.
- 로컬 Rust proxy가 Anthropic과 OpenAI-compatible 프로토콜을 변환합니다.
- Claude Code는 채팅 UI를 바꾸지 않고 설정된 무료 채널을 통해 사용할 수 있습니다.
- 키, 모델 override, 로컬 모델 설정은 settings에서 관리합니다.

현재 기본 프로그래밍 모델:

| 채널 | 기본 모델 |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## 빠른 시작

```bash
cd app
npm install
npm run dev
```

데스크톱 앱 실행:

```bash
cd app
npm run desktop
```

프로덕션 패키지 빌드:

```bash
cd app
npm run package
```

## 기본 사용법

### 무료 채널 등록

1. 하단 **Channel** 메뉴를 열고 경고 표시가 있는 무료 채널을 선택합니다. 예: **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Channel 메뉴에서 설정되지 않은 무료 채널 선택" width="960">
</p>

2. API key 대화상자에서 **Open registration site**를 클릭합니다.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="provider 등록 사이트 열기" width="960">
</p>

3. provider 페이지에서 새 API key를 만들고 복사합니다.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="provider API key 생성" width="960">
</p>

4. FreeUltraCode에 key를 붙여넣고 **Save and Use**를 클릭합니다. 저장 후 경고 표시가 사라집니다.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="설정 완료된 무료 채널" width="960">
</p>

5. **Settings** -> **Channels** -> **Free Channels**에서도 모든 무료 채널을 관리할 수 있습니다.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="settings에서 무료 채널 관리" width="960">
</p>

채널이 준비되면 하단 입력창에서 해당 경로로 대화할 수 있습니다.

### Chat으로 프로그래밍하기

1. 왼쪽 사이드바에서 **+ New Session**을 클릭합니다.
2. 하단 컨트롤에서 runtime, channel, permission mode, workspace를 선택합니다.
3. 목표 동작, 관련 파일, 승인 기준, 제약 조건을 포함해 요청을 작성합니다.
4. 실행 중에는 파일 읽기, 검색, 수정, 검증 단계가 별도 항목으로 표시됩니다.
5. 결과를 조정해야 하면 같은 채팅에서 후속 요청을 이어가면 됩니다.

## 동작 방식

```text
사용자 요청
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

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| Desktop shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS variables |
| Icons | lucide-react |
| Provider routing | Claude Code, Codex, Gemini, extensible provider settings |
| Free-channel proxy | Rust `tiny_http` + `ureq`, Anthropic/OpenAI protocol translation |

## 프로젝트 구조

```text
app/
  src/
    components/  공용 UI 컴포넌트
    lib/         provider 설정, 무료 채널 라우팅, persistence
    panels/      Sidebar, chat dock, settings, scheduling UI
    store/       Zustand state와 로컬 기록
  src-tauri/
    src/
      free_proxy.rs    Rust reverse proxy + Anthropic/OpenAI translation
      lib.rs           Tauri commands, filesystem/history bridge
  doc/                 튜토리얼, 현지화 README, 스크린샷
```

## 문서

- [무료 채널 등록 가이드 중국어](register-free-channel.md)
- [English README](../../README.md)

## 개발

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## 커뮤니티

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## 라이선스

아직 라이선스가 지정되지 않았습니다.
