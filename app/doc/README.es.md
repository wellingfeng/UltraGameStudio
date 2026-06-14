# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | Español | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.ar.md">العربية</a>
</div>

En un motor de juego, el código es solo una pequeña parte del trabajo. El resto son assets y pipeline: materiales, blueprints, terreno, cielo, UI, animación esquelética, empaquetado, rendimiento. FreeUltraCode es un agente de programación al estilo de Claude Code / Codex / Gemini reconstruido en torno a esa realidad: entiende los conceptos de los motores de juego, genera toda la gama de assets de juego (imágenes, modelos 3D, animación de sprites 2D, atlas, audio, rigging, vídeo) y enruta el trabajo rutinario por canales gratuitos o de bajo coste para reservar la cuota premium para lo importante.

<p align="center">
  <strong>Interfaz UMG de Unreal Engine en un clic</strong><br>
  <img src="images/game/JMsXEKE.png" alt="FreeUltraCode genera una interfaz UMG de Unreal Engine en un clic" width="960">
</p>

<p align="center">
  <strong>Generación de modelo 3D en un clic</strong><br>
  <img src="images/game/noYfqPt.png" alt="FreeUltraCode genera un modelo 3D en un clic" width="960">
</p>

<p align="center">
  <strong>Imágenes, sprites, meshes, audio, rigging y vídeo — gestionados por un solo agente de programación</strong><br>
  <img src="images/game/gmclmLS.png" alt="Generación unificada de assets de juego de FreeUltraCode" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="Flujo de assets de juego de FreeUltraCode" width="960">
</p>

## Por qué FreeUltraCode

Hoy la IA es lo bastante buena como para escribir la mayor parte del código por sí sola. El rol del programador se desplaza hacia describir la intención, verificar la salida y orquestar agentes. Pero un juego no es solo código. Un motor de juego está lleno de materiales, blueprints, terreno, cielo, UI, animación esquelética, empaquetado y ajuste de rendimiento — y la mayoría de los agentes de programación genéricos no entienden nada de eso.

FreeUltraCode toma un agente al estilo de Claude Code / Codex / Gemini y lo personaliza a fondo para el desarrollo de juegos:

- **Habla el lenguaje de los motores de juego.** El agente viene preparado con conceptos de desarrollo de juegos para razonar sobre materiales, blueprints, terreno, iluminación, UI (UMG y otras), animación esquelética, build/empaquetado y optimización de rendimiento.
- **Genera todos los tipos de asset que un juego necesita.** Imágenes, modelos 3D, animación de sprites 2D, atlas de sprites, audio, rigging esquelético y vídeo se producen desde la misma superficie y se gestionan con un único flujo de agente.
- **Equipo de expertos en desarrollo de juegos integrado.** Más de 40 roles especializados (director técnico, programador de gameplay/IA/red/herramientas, diseñador de nivel/economía, directores de arte y audio, QA, release manager, etc.) que abarcan Unity, Unreal, Godot y Web.
- **Reserva la cuota premium para lo que importa.** Enruta el trabajo rutinario por canales gratuitos, de prueba o de bajo coste, y mantén claves, ajustes e historial en local.

## Qué puede hacer

### Chat de desarrollo de juegos

- Pide código de gameplay, integración de motor, lógica de shaders/materiales, scripts de build, investigación de bugs, refactors, tests y notas de versión.
- Trabaja en proyectos de Unity, Unreal, Godot o Web — el agente razona sobre conceptos del motor, no solo sobre archivos.
- Adjunta rutas de archivos o arrastra archivos al compositor.
- Revisa salida en streaming, logs, referencias de archivos y resúmenes en una sola superficie de chat.
- Continúa con peticiones de seguimiento en la misma sesión.

### Generación de assets de juego

Cada tipo de asset que un juego necesita se puede generar desde la misma superficie y aplicar al proyecto, y luego devolver al modelo de programación — todo en el mismo historial. Cada generador pasa por el proveedor que hayas configurado.

| Asset | Qué produce | Modo |
| --- | --- | --- |
| Imágenes | Concept art, mockups de UI, iconos, pósteres, texturas, referencias | `/image`, `/img`, `/draw`, `/生图` o `/image-mode-start` |
| Grafos ComfyUI | Pipelines de imagen editables basados en nodos | `/comfyui-mode-start` |
| Sprites 2D | Sprites de juego, frames de secuencia, spritesheets | `/sprite` o `/sprite-mode-start` |
| Modelos 3D | Props, personajes, meshes de escena, blockouts | `/mesh-mode-start` (busca con `/mesh-search`) |
| Música | BGM, banda sonora, clips musicales | `/music` o `/music-mode-start` |
| Voz | Líneas de voz y narración | `/speech-mode-start` |
| Vídeo | Clips de vídeo y assets animados | `/video` o `/video-mode-start` |

El agente primero pule tu prompt, lo envía al proveedor configurado y muestra el resultado en el flujo de chat. Sal de cualquier modo con su comando `*-mode-end` correspondiente.

### Equipo de expertos en desarrollo de juegos

FreeUltraCode incluye más de 40 especialistas en desarrollo de juegos que el agente convoca automáticamente según la tarea:

- **Especialistas de motor** para Unity, Unreal, Godot (GDScript / C# / GDExtension / shaders) y Web.
- **Programación**: director técnico, programadores lead/motor/gameplay/IA/red/herramientas/UI.
- **Diseño**: diseñadores de gameplay, nivel, economía, live-ops y narrativa.
- **Arte y audio**: directores y especialistas, VFX, diseño de sonido, dirección de audio.
- **Producción, calidad y release**: productor, QA lead/tester, devops, seguridad, localización, release manager.

Configura el motor activo, el modo council y los expertos habilitados en **Settings**.

### Enrutamiento de modelos gratuitos

- **20+ canales remotos y runtimes locales**: NVIDIA NIM, OpenRouter, GitHub Models, Hugging Face Router, SambaNova Cloud, Together AI, Google Gemini, DeepSeek, Mistral, Mistral Codestral, OpenCode, Wafer, Kimi, Cerebras, Groq, Fireworks, Z.ai, LLM7, Kilo Gateway, además de Ollama, LM Studio y llama.cpp.
- **Rutas experimentales sin key**: LLM7 y Kilo Gateway se pueden probar sin API key, pero conviene usarlas solo con prompts de código no sensibles.
- **Rutas oficiales con cuota gratis o de prueba**: las claves de proveedor se guardan localmente en la app.
- El proxy local en Rust traduce entre protocolos Anthropic y OpenAI-compatible.
- Claude Code puede usar canales gratuitos configurados sin cambiar la interfaz de chat.
- Las claves, cambios de modelo y modelos locales se gestionan desde la configuración.

<p align="center">
  <strong>Enrutamiento de canales gratuitos</strong><br>
  <img src="images/hero-free-channels.es.png" alt="Captura del enrutamiento de canales gratuitos de FreeUltraCode" width="960">
</p>

Modelos predeterminados orientados a programación:

| Canal | Modelo predeterminado |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### Workflow dinámico (/ultracode)

Para tareas de programación complejas con múltiples pasos, `/ultracode <tarea>` genera al instante un harness de ejecución a medida y lo ejecuta de inmediato. Sin necesidad de lienzo visual.

- Describe la tarea en lenguaje natural — el planificador construye un harness con subagentes paralelos, verificación adversarial y puertas de aceptación.
- Seis estrategias internas se eligen automáticamente: clasificar-y-actuar, abanico-y-síntesis, verificación-adversarial, generar-y-filtrar, torneo, bucle-hasta-completar.
- Cada ejecución queda completamente registrada en `.fuc-run/<run-id>/` con libro de tareas, eventos, veredicto y resultado final.
- Ejecuta desde la app de escritorio o por CLI: `fuc ultracode "<tarea>" --json --interactive --cwd <workspace>`.
- Cero configuración — reutiliza las credenciales locales de `claude` CLI.

#### Free Auto — Cambio automático multicanal

El canal **Auto** (`freecc:auto` en el menú Channel) enruta automáticamente cada solicitud al mejor canal gratuito disponible, sin intervención manual.

- Rota por todos los canales gratuitos configurados, saltando automáticamente los que alcanzan límites de tasa (429) o devuelven errores upstream (5xx).
- Seguimiento de enfriamiento por canal con backoff: cuando un canal falla, se pausa antes de reintentarlo.
- Admite una sobrescritura opcional de modelo para que todas las solicitudes usen el mismo modelo.
- Si todos los canales están agotados, devuelve un 503 con el registro de fallos para diagnóstico.

#### Cadena multi-proveedor: DeepSeek → CodeX

Con `/ultracode`, el harness puede encadenar múltiples proveedores entre los pasos del plan. Patrón típico: DeepSeek produce borradores de bajo coste, CodeX los refina hasta la calidad final.

- El **plan de harness dinámico** permite sobrescribir `model` por paso — asigna DeepSeek a pasos de lluvia de ideas/clasificación y CodeX/Gemini a implementación/verificación.
- **Compatibilidad cc-switch**: FreeUltraCode lee la configuración CLI `cc-switch`; cualquier proveedor ya configurado para Claude Code está disponible de inmediato.
- La estrategia **abanico-y-síntesis** paraleliza workers DeepSeek en subtareas independientes, luego una puerta de consenso (CodeX) sintetiza y verifica los resultados.

#### Selección de canal sensible a la velocidad

El canal Auto del proxy gratuito prioriza canales según señales de disponibilidad en tiempo real:

- **Consciente de límites de tasa**: los canales que devuelven 429 se enfrían 30+ segundos antes de reintentar, evitando intentos fallidos en upstreams saturados.
- **Fallo rápido en errores**: los errores no reintentables (fallos de autenticación 4xx, caídas upstream 5xx) se rastrean por canal con enfriamiento; el router Auto los salta.
- **Presupuesto de tiempo de conexión**: cada intento de canal está sujeto al timeout del upstream; el router Auto no se bloquea en un solo upstream lento.
- **Orden natural por reactividad**: los canales exitosos se prueban primero; los canales con error se desplazan al final de la lista.

Estas funciones garantizan ejecuciones resilientes de harness `/ultracode`, incluso cuando proveedores individuales están lentos, limitados o temporalmente no disponibles.

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

### Generar assets de juego

Los modos de asset convierten el compositor en una superficie de generación de assets sin salir del historial. Útiles para crear mockups de UI, iconos, texturas, sprites, modelos 3D, audio y vídeo antes de volver al código. El ejemplo de abajo usa el modo de imagen; los modos sprite, mesh, música, voz y vídeo funcionan igual con sus comandos `*-mode-start`.

1. Abre **Settings** -> **Images** (o la sección de asset correspondiente), elige el proveedor predeterminado y completa la API key, Account ID, Base URL o endpoint local de ComfyUI que pida.
2. En una sesión de chat, escribe `/image-mode-start`. También puedes iniciar y generar en el mismo mensaje:

```text
/image-mode-start una textura de muro de piedra estilizada para una mazmorra fantástica, tileable, 1024x1024
```

3. Mientras esté activo, los mensajes normales generan assets en vez de ejecutar ediciones de código. El selector **Channel** cambia a proveedores de assets.
4. Describe el asset. FreeUltraCode primero mejora el prompt con el modelo de programación y luego lo envía al proveedor configurado.

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="El modo de asset genera elementos dentro de la misma sesión de FreeUltraCode" width="720">
</p>

5. Envía `/image-mode-end` para volver al canal y modelo de programación. Para un solo asset sin modo persistente, usa `/image`, `/img`, `/draw`, `/生图`, `/sprite`, `/music` o `/video` seguido del prompt.

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
    lib/         Configuración de proveedores, rutas gratuitas, generación de assets (imagen/sprite/3D/música/voz/vídeo/ComfyUI), equipo de expertos de juego, persistencia
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
