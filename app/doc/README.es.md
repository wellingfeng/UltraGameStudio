# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | Español | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

No todas las tareas de programación justifican gastar cuota de los modelos más caros. FreeUltraCode reúne Claude Code, Codex, Gemini, canales gratuitos y modelos locales en una interfaz de chat local. Usa modelos baratos para explorar y deja los modelos más estables para las decisiones importantes.

<p align="center">
  <strong>Enrutamiento de canales gratuitos</strong><br>
  <img src="images/hero-free-channels.es.png" alt="Captura del enrutamiento de canales gratuitos de FreeUltraCode" width="960">
</p>

## Por qué FreeUltraCode

Los agentes de programación son útiles, pero la cuota de modelos premium se consume rápido. FreeUltraCode mantiene la experiencia de chat local y facilita enviar solicitudes a canales gratuitos, de prueba o de bajo coste cuando son suficientes.

- Usa GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Gemini, DeepSeek, Kimi, Groq, OpenRouter, NVIDIA NIM, Z.ai, Kilo, LLM7, Ollama, LM Studio y llama.cpp.
- Mantén las API keys y la configuración de proveedores en tu máquina.
- Cambia runtime, canal, modo de permisos y workspace desde el compositor de chat.
- Guarda localmente historial, favoritos, prompts programados y contexto del workspace.
- Usa modelos locales sin API key cuando tu hardware lo permita.

## Qué puede hacer

### Chat para programación

- Pide cambios de código, investigación de bugs, refactors, tests, notas de versión o documentación.
- Adjunta rutas de archivos o arrastra archivos al compositor.
- Revisa salida en streaming, logs de comandos, referencias de archivos y resúmenes en una sola superficie de chat.
- Continúa con peticiones de seguimiento en la misma sesión.

### Enrutamiento de modelos gratuitos

- **20+ canales remotos y runtimes locales**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, además de Ollama, LM Studio y llama.cpp.
- **Rutas experimentales sin key**: LLM7 y Kilo Gateway se pueden probar sin API key, pero conviene usarlas solo con prompts de código no sensibles.
- **Rutas oficiales con cuota gratis o de prueba**: las claves de proveedor se guardan localmente en la app.
- El proxy local en Rust traduce entre protocolos Anthropic y OpenAI-compatible.
- Claude Code puede usar canales gratuitos configurados sin cambiar la interfaz de chat.
- Las claves, cambios de modelo y modelos locales se gestionan desde la configuración.

Modelos predeterminados orientados a programación:

| Canal | Modelo predeterminado |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

## Inicio rápido

```bash
cd app
npm install
npm run dev
```

Para la app de escritorio:

```bash
cd app
npm run desktop
```

Para crear un paquete de producción:

```bash
cd app
npm run package
```

## Uso básico

### Registrar un canal gratuito

1. Abre el menú inferior **Channel** y elige un canal gratuito con marca de advertencia, por ejemplo **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="Elegir un canal gratuito sin configurar en el menú Channel" width="960">
</p>

2. En el diálogo de API key, haz clic en **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="Abrir el sitio de registro del proveedor" width="960">
</p>

3. Crea una nueva API key en la página del proveedor y cópiala.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="Crear una API key del proveedor" width="960">
</p>

4. Pega la key en FreeUltraCode y haz clic en **Save and Use**. Tras guardar, desaparece la marca de advertencia.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="Canal gratuito configurado sin advertencia" width="960">
</p>

5. También puedes gestionar todos los canales desde **Settings** -> **Channels** -> **Free Channels**.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="Gestionar canales gratuitos en la configuración" width="960">
</p>

Cuando el canal esté listo, usa la entrada inferior para chatear por esa ruta.

### Usar Chat para programar

1. Haz clic en **+ New Session** en la barra lateral.
2. Elige runtime, canal, modo de permisos y workspace desde los controles inferiores.
3. Describe la tarea con el comportamiento esperado, archivos afectados, criterios de aceptación y restricciones.
4. Durante la ejecución, FreeUltraCode muestra lecturas de archivos, búsquedas, ediciones y verificaciones como entradas separadas.
5. Si necesitas ajustar el resultado, continúa en el mismo chat con una petición de seguimiento.

## Cómo funciona

```text
Solicitud del usuario
    |
    v
Compositor de chat
    |
    +--> runtime / canal / permisos / workspace seleccionados
             |
             +--> API del proveedor, CLI local o proxy local de canal gratuito
                        |
                        +--> salida en streaming, log de herramientas e historial
```

## Stack tecnológico

| Área | Tecnología |
| --- | --- |
| Shell de escritorio | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| Estado | Zustand |
| Estilos | Tailwind CSS, variables CSS |
| Iconos | lucide-react |
| Enrutamiento de proveedores | Claude Code, Codex, Gemini, configuración extensible |
| Proxy de canales gratuitos | Rust `tiny_http` + `ureq`, traducción Anthropic/OpenAI |

## Estructura del proyecto

```text
app/
  src/
    components/  UI compartida
    lib/         Configuración de proveedores, rutas gratuitas, persistencia
    panels/      Sidebar, chat dock, configuración, programación
    store/       Estado Zustand e historial local
  src-tauri/
    src/
      free_proxy.rs    Proxy inverso Rust + traducción Anthropic/OpenAI
      lib.rs           Comandos Tauri, puente de archivos e historial
  doc/                 Tutoriales, READMEs localizados, capturas
```

## Documentación

- [Guía china para registrar un canal gratuito](register-free-channel.md)
- [README en inglés](../../README.md)

## Desarrollo

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## Comunidad

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## Licencia

Todavía no se ha especificado una licencia.
