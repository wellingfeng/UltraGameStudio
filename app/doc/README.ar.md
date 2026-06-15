# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | العربية
</div>

في محرك الألعاب، يمثل الكود جزءًا صغيرًا فقط من العمل. أما البقية فهي الأصول وخط الإنتاج: المواد والمخططات (blueprints) والتضاريس والسماء وواجهة المستخدم وتحريك الهياكل العظمية والتغليف والأداء. FreeUltraCode هو وكيل برمجة بأسلوب Claude Code / Codex / Gemini أُعيد بناؤه حول هذا الواقع: يفهم مفاهيم محركات الألعاب، ويولّد كامل مجموعة أصول اللعبة (صور، نماذج ثلاثية الأبعاد، تحريك sprites ثنائي الأبعاد، أطالس، صوت، rigging، فيديو)، ويوجّه العمل الروتيني عبر قنوات مجانية أو منخفضة التكلفة ليبقى رصيد النماذج المدفوعة لما يهم فعلًا.

<p align="center">
  <strong>واجهة UMG لـ Unreal Engine بنقرة واحدة</strong><br>
  <img src="images/game/JMsXEKE.png" alt="FreeUltraCode يولّد واجهة UMG لـ Unreal Engine بنقرة واحدة" width="960">
</p>

<p align="center">
  <strong>توليد نموذج ثلاثي الأبعاد بنقرة واحدة</strong><br>
  <img src="images/game/noYfqPt.png" alt="FreeUltraCode يولّد نموذجًا ثلاثي الأبعاد بنقرة واحدة" width="960">
  <br><br>
  <img src="images/20260615-214236.jpg" alt="معاينة النموذج ثلاثي الأبعاد الذي أنشأه FreeUltraCode" width="960">
</p>

<p align="center">
  <strong>الصور والـ sprites والـ meshes والصوت والـ rigging والفيديو — تُدار جميعها عبر وكيل برمجة واحد</strong><br>
  <img src="images/game/gmclmLS.png" alt="توليد أصول الألعاب الموحد في FreeUltraCode" width="960">
  <br><br>
  <img src="images/game/jXgMffC.png" alt="سير عمل أصول الألعاب في FreeUltraCode" width="960">
</p>

## لماذا FreeUltraCode

أصبح الذكاء الاصطناعي اليوم جيدًا بما يكفي لكتابة معظم الكود بنفسه. ويتحول دور المبرمج نحو وصف النية والتحقق من المخرجات وتنسيق الوكلاء. لكن اللعبة ليست مجرد كود. محرك الألعاب مليء بالمواد والمخططات والتضاريس والسماء وواجهة المستخدم وتحريك الهياكل العظمية والتغليف وضبط الأداء — ومعظم وكلاء البرمجة العامين لا يفهمون أيًا من ذلك.

يأخذ FreeUltraCode وكيلًا بأسلوب Claude Code / Codex / Gemini ويخصصه بعمق لتطوير الألعاب:

- **يتحدث لغة محركات الألعاب.** الوكيل مُهيأ بمفاهيم تطوير الألعاب ليستطيع الاستدلال حول المواد والمخططات والتضاريس والإضاءة وواجهة المستخدم (UMG وغيرها) وتحريك الهياكل العظمية والبناء/التغليف وتحسين الأداء.
- **يولّد كل أنواع الأصول التي تحتاجها اللعبة.** الصور والنماذج ثلاثية الأبعاد وتحريك sprites ثنائي الأبعاد وأطالس الـ sprites والصوت والـ rigging العظمي والفيديو تُنتج جميعها من الواجهة نفسها وتُدار عبر سير عمل وكيل واحد.
- **فريق خبراء تطوير ألعاب مدمج.** أكثر من 40 دورًا متخصصًا (مدير تقني، مبرمج gameplay/ذكاء اصطناعي/شبكات/أدوات، مصمم مراحل/اقتصاد، مديرو فن وصوت، QA، مدير إصدار، وغيرهم) تغطي Unity وUnreal وGodot وWeb.
- **يحفظ الرصيد المدفوع لما يهم.** وجّه العمل الروتيني عبر قنوات مجانية أو تجريبية أو منخفضة التكلفة، واحتفظ بالمفاتيح والإعدادات والسجل محليًا.

## ما الذي يقدمه

### دردشة تطوير الألعاب

- اطلب كود gameplay وتكامل المحرك ومنطق الـ shaders/المواد وسكربتات البناء والبحث عن أسباب الأخطاء والـ refactor والاختبارات وملاحظات الإصدار.
- اعمل على مشاريع Unity أو Unreal أو Godot أو Web — يستدل الوكيل على مفاهيم المحرك لا على الملفات فقط.
- أضف مسارات ملفات أو اسحب الملفات إلى حقل الإدخال.
- راجع الإخراج المتدفق والسجلات ومراجع الملفات والملخصات في واجهة دردشة واحدة.
- تابع بطلبات إضافية في نفس الجلسة.

### توليد أصول الألعاب

يمكن توليد كل نوع من الأصول التي تحتاجها اللعبة من الواجهة نفسها وتطبيقه على مشروعك ثم إعادته إلى نموذج البرمجة — كل ذلك في السجل نفسه. يمر كل مولّد عبر المزود الذي أعددته.

| الأصل | ما يُنتجه | الوضع |
| --- | --- | --- |
| الصور | concept art، نماذج واجهة، أيقونات، ملصقات، textures، مراجع | `/image` أو `/img` أو `/draw` أو `/生图` أو `/image-mode-start` |
| رسوم ComfyUI | خطوط إنتاج صور قابلة للتحرير قائمة على العقد | `/comfyui-mode-start` |
| sprites ثنائية الأبعاد | sprites ألعاب، إطارات متتابعة، spritesheets | `/sprite` أو `/sprite-mode-start` |
| نماذج ثلاثية الأبعاد | props، شخصيات، meshes مشاهد، blockouts | `/mesh-mode-start` (ابحث في المكتبة بـ `/mesh-search`) |
| الموسيقى | BGM، موسيقى تصويرية، مقاطع موسيقية | `/music` أو `/music-mode-start` |
| الصوت/الكلام | حوارات صوتية وسرد | `/speech-mode-start` |
| الفيديو | مقاطع فيديو وأصول متحركة | `/video` أو `/video-mode-start` |

يحسّن الوكيل أولًا الـ prompt الخاص بك، ويرسله إلى المزود المُعد، ويعرض النتيجة في تدفق الدردشة مع الـ prompt وتفاصيل المزود. اخرج من أي وضع بأمر `*-mode-end` المقابل.

### فريق خبراء تطوير الألعاب

يأتي FreeUltraCode مع أكثر من 40 متخصصًا في تطوير الألعاب يستدعيهم الوكيل تلقائيًا حسب المهمة:

- **متخصصو المحركات** لـ Unity وUnreal وGodot (GDScript / C# / GDExtension / shaders) وWeb.
- **البرمجة**: مدير تقني، مبرمجو lead/محرك/gameplay/ذكاء اصطناعي/شبكات/أدوات/واجهة.
- **التصميم**: مصممو gameplay ومراحل واقتصاد وlive-ops وسرد.
- **الفن والصوت**: مديرون ومتخصصون، VFX، تصميم صوت، إخراج صوتي.
- **الإنتاج والجودة والإصدار**: منتج، QA lead/مختبِر، devops، أمان، توطين، مدير إصدار.

اضبط المحرك النشط ووضع council والخبراء المُفعّلين من **Settings**.

### توجيه النماذج المجانية

- **20+ قناة بعيدة مع runtimes محلية**: NVIDIA NIM وOpenRouter وGitHub Models وHugging Face Router وSambaNova Cloud وTogether AI وGoogle Gemini وDeepSeek وMistral وMistral Codestral وOpenCode وWafer وKimi وCerebras وGroq وFireworks وZ.ai وLLM7 وKilo Gateway، بالإضافة إلى Ollama وLM Studio وllama.cpp.
- **مسارات تجريبية بدون key**: يمكن تجربة LLM7 وKilo Gateway بدون API key، لكنها مناسبة فقط لprompts برمجية غير حساسة.
- **مسارات رسمية بحصة مجانية أو تجريبية**: مفاتيح المزودين تحفظ محليًا داخل التطبيق.
- يقوم proxy المحلي المكتوب بRust بالترجمة بين بروتوكولات Anthropic وOpenAI-compatible.
- يمكن لClaude Code المرور عبر القنوات المجانية المضبوطة بدون تغيير واجهة الدردشة.
- تتم إدارة المفاتيح وتجاوزات النماذج والنماذج المحلية من الإعدادات.

<p align="center">
  <strong>توجيه القنوات المجانية</strong><br>
  <img src="images/hero-free-channels.ar.png" alt="لقطة شاشة لتوجيه القنوات المجانية في FreeUltraCode" width="960">
</p>

النماذج الافتراضية الحالية الموجهة للبرمجة:

| القناة | النموذج الافتراضي |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

### سير العمل الديناميكي (/ultracode)

للمهام البرمجية المعقدة متعددة الخطوات، يقوم `/ultracode <مهمة>` بإنشاء هيكل تنفيذ مخصص فوراً وتشغيله مباشرة. لا حاجة للوحة مرئية.

- صِف المهمة باللغة الطبيعية — يبني المخطط هيكلاً بوكلاء فرعيين متوازيين، وتحقق تضادي، وبوابات قبول.
- ست استراتيجيات داخلية تُختار تلقائياً: صنّف ونفّذ، توسيع وتوليف، تحقق تضادي، توليد وتصفية، دورة تنافسية، تكرار حتى الإكمال.
- كل تشغيلة تُسجل بالكامل تحت `.fuc-run/<run-id>/` مع سجل المهام، والأحداث، والحكم، والنتيجة النهائية.
- شغّل من تطبيق سطح المكتب أو عبر CLI: `fuc ultracode "<مهمة>" --json --interactive --cwd <workspace>`.
- بدون إعدادات — يعيد استخدام بيانات اعتماد تسجيل الدخول المحلية لـ `claude` CLI.

#### Free Auto — التبديل التلقائي متعدد القنوات

تقوم قناة **Auto** (`freecc:auto` في قائمة Channel) بتوجيه كل طلب تلقائياً عبر أفضل قناة مجانية متاحة، دون تبديل يدوي.

- التدوير عبر جميع القنوات المجانية المكوّنة، مع تخطي القنوات التي تصل لحدود المعدل (429) أو ترجع أخطاء المنبع (5xx) تلقائياً.
- تتبع فترات التهدئة لكل قناة مع تراجع: عند حدوث خطأ، تتوقف القناة مؤقتاً قبل إعادة المحاولة.
- دعم تجاوز النموذج الاختياري بحيث تستخدم جميع الطلبات الموجهة تلقائياً نفس النموذج.
- عند استنفاد جميع القنوات، تُرجع 503 مع سجل الفشل لتشخيص الانقطاع.

#### سلسلة المزودين المتعددين: DeepSeek → CodeX

مع `/ultracode`، يمكن للهيكل ربط مزودين متعددين عبر خطوات الخطة تلقائياً. النمط النموذجي: تنتج DeepSeek مسودات سريعة بتكلفة منخفضة، ثم تتولى CodeX التحسين للجودة النهائية.

- **خطة الهيكل الديناميكي** تدعم تجاوز `model` لكل خطوة — خصص DeepSeek للعصف الذهني/التصنيف وCodeX/Gemini للتنفيذ/التحقق.
- **توافق cc-switch**: يقرأ FreeUltraCode تكوين `cc-switch` CLI؛ أي مزود مكوّن لتوجيه Claude Code متاح فوراً لخطوات ultracode.
- استراتيجية **التوسيع والتوليف** توزع عمال DeepSeek بالتوازي على مهام فرعية مستقلة، ثم تقوم بوابة الإجماع (CodeX) بتوليف النتائج والتحقق منها.

#### اختيار القناة حسب السرعة

تقوم قناة Auto في الوكيل المجاني بترتيب أولوية القنوات بناءً على إشارات التوفر في الوقت الفعلي:

- **الوعي بحدود المعدل**: القنوات التي ترجع 429 تُهدأ لمدة 30+ ثانية قبل إعادة المحاولة.
- **الفشل السريع عند الأخطاء**: الأخطاء غير القابلة لإعادة المحاولة (فشل المصادقة 4xx، تعطل المنبع 5xx) تُتتبع مع تهدئة؛ يتخطاها موجّه Auto.
- **ميزانية وقت الاتصال**: كل محاولة قناة تخضع لمهلة المنبع؛ لا يحظر موجّه Auto على منبع بطيء واحد.
- **الترتيب الطبيعي حسب الاستجابة**: القنوات الناجحة تُجرب أولاً؛ القنوات ذات الأخطاء تُؤجل لنهاية القائمة.

تضمن هذه الميزات مرونة تشغيل هيكل `/ultracode` حتى عندما يكون المزودون المجانيون الفرديون بطيئين أو محدودي المعدل أو غير متاحين مؤقتاً.

## البدء السريع

```bash
cd app
npm install
npm run dev
```

لتشغيل تطبيق سطح المكتب:

```bash
cd app
npm run desktop
```

لبناء حزمة إنتاج:

```bash
cd app
npm run package
```

## الاستخدام الأساسي

### تسجيل قناة مجانية

1. افتح قائمة **Channel** في الأسفل واختر قناة مجانية عليها علامة تحذير، مثل **Free · OpenRouter**.

<p align="center">
  <img src="images/注册免费渠道/1-配置大模型.png" alt="اختيار قناة مجانية غير مضبوطة من قائمة Channel" width="960">
</p>

2. في مربع API key اضغط **Open registration site**.

<p align="center">
  <img src="images/注册免费渠道/2-注册.png" alt="فتح موقع تسجيل المزود" width="960">
</p>

3. أنشئ API key جديدًا في صفحة المزود ثم انسخه.

<p align="center">
  <img src="images/注册免费渠道/3-新建token.png" alt="إنشاء API key لدى المزود" width="960">
</p>

4. الصق المفتاح في FreeUltraCode واضغط **Save and Use**. بعد الحفظ تختفي علامة التحذير.

<p align="center">
  <img src="images/注册免费渠道/4-配置好了.png" alt="قناة مجانية جاهزة بعد الإعداد" width="960">
</p>

5. يمكنك أيضًا إدارة كل القنوات من **Settings** -> **Channels** -> **Free Channels**.

<p align="center">
  <img src="images/注册免费渠道/5-设置中的免费渠道.png" alt="إدارة القنوات المجانية من الإعدادات" width="960">
</p>

بعد أن تصبح القناة جاهزة، استخدم حقل الإدخال في الأسفل للدردشة عبر هذا المسار.

### توليد أصول الألعاب

تحوّل أوضاع الأصول حقل الدردشة إلى سطح توليد أصول مع الاحتفاظ بالسجل نفسه. مفيدة لإنشاء نماذج واجهة وأيقونات وtextures وsprites ونماذج ثلاثية الأبعاد وصوت وفيديو قبل الرجوع إلى البرمجة. المثال أدناه يستخدم وضع الصور؛ أما أوضاع الـ sprite والـ mesh والموسيقى والكلام والفيديو فتعمل بالطريقة نفسها عبر أوامر `*-mode-start` الخاصة بها.

1. افتح **Settings** -> **Images** (أو قسم الأصل المناسب)، اختر المزود الافتراضي، ثم أدخل API key أو Account ID أو Base URL أو endpoint محلي لـ ComfyUI حسب المتطلبات.
2. في جلسة دردشة، اكتب `/image-mode-start`. يمكنك بدء الوضع والتوليد في الرسالة نفسها:

```text
/image-mode-start texture لجدار حجري بأسلوب مُنمّق لزنزانة فانتازيا، قابلة للتبليط، 1024x1024
```

3. أثناء تفعيل الوضع، تولد الرسائل العادية أصولًا بدل تنفيذ تعديلات كود. يتحول محدد **Channel** إلى مزودي الأصول.
4. صف الأصل المطلوب. يطلب FreeUltraCode أولًا من نموذج البرمجة تحسين الـ prompt، ثم يرسله إلى المزود المضبوط.

<p align="center">
  <img src="images/生图/session-2026-06-07-2351.png" alt="وضع الأصول يولد عناصر داخل جلسة FreeUltraCode نفسها" width="720">
</p>

5. أرسل `/image-mode-end` للعودة إلى قناة ونموذج البرمجة. لأصل واحد بدون وضع مستمر، استخدم `/image` أو `/img` أو `/draw` أو `/生图` أو `/sprite` أو `/music` أو `/video` متبوعًا بالـ prompt.

## كيف يعمل

```text
طلب المستخدم
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

## التقنيات

| المجال | التقنية |
| --- | --- |
| Desktop shell | Tauri 2, Rust |
| Frontend | React 18, Vite 5, TypeScript 5 |
| State | Zustand |
| Styling | Tailwind CSS, CSS variables |
| Icons | lucide-react |
| Provider routing | Claude Code, Codex, Gemini, extensible provider settings |
| Free-channel proxy | Rust `tiny_http` + `ureq`, Anthropic/OpenAI protocol translation |

## بنية المشروع

```text
app/
  src/
    components/  مكونات UI مشتركة
    lib/         إعدادات المزودين، توجيه القنوات المجانية، توليد الأصول (صور/sprites/ثلاثي الأبعاد/موسيقى/كلام/فيديو/ComfyUI)، فريق خبراء الألعاب، التخزين
    panels/      Sidebar, chat dock, settings, scheduling UI
    store/       Zustand state and local history
  src-tauri/
    src/
      free_proxy.rs    Rust reverse proxy + Anthropic/OpenAI translation
      lib.rs           Tauri commands, filesystem/history bridge
  doc/                 Tutorials, localized READMEs, screenshots
```

## التوثيق

- [دليل تسجيل القنوات المجانية بالصينية](register-free-channel.md)
- [README بالإنجليزية](../../README.md)

## التطوير

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run desktop
npm run package
```

## المجتمع

- Discord: <https://discord.gg/2C9ptSEFG>
- QQ Group: `149523963`
- Issues: <https://github.com/wellingfeng/FreeUltraCode/issues>

## الرخصة

لم يتم تحديد رخصة بعد.
