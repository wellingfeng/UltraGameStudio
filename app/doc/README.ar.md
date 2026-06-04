# FreeUltraCode

<div align="center">
  <a href="../../README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ru.md">Русский</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.hi.md">हिन्दी</a> | العربية
</div>

ليس كل عمل برمجي يستحق استهلاك حصة أغلى النماذج. يجمع FreeUltraCode بين Claude Code وCodex وGemini والقنوات المجانية والنماذج المحلية في واجهة دردشة محلية واحدة. استخدم النماذج الأرخص للاستكشاف والعمل المتكرر، واترك القرارات المهمة للنماذج الأكثر استقرارًا.

<p align="center">
  <strong>توجيه القنوات المجانية</strong><br>
  <img src="images/hero-free-channels.ar.png" alt="لقطة شاشة لتوجيه القنوات المجانية في FreeUltraCode" width="960">
</p>

## لماذا FreeUltraCode

وكلاء البرمجة مفيدون، لكن حصة النماذج المدفوعة تنفد بسرعة. يحافظ FreeUltraCode على تجربة الدردشة محلية، ويسهل توجيه الطلبات إلى قنوات مجانية أو تجريبية أو منخفضة التكلفة عندما تكون كافية.

- استخدم GitHub Models وHugging Face Router وSambaNova Cloud وTogether AI وGemini وDeepSeek وKimi وGroq وOpenRouter وNVIDIA NIM وZ.ai وKilo وLLM7 وOllama وLM Studio وllama.cpp.
- تبقى مفاتيح API وإعدادات المزودين على جهازك.
- يمكنك تبديل runtime وchannel ووضع الصلاحيات وworkspace من واجهة الدردشة.
- يتم حفظ سجل الدردشة والمفضلة والprompts المجدولة وسياق workspace محليًا.
- يمكن استخدام النماذج المحلية بدون API key عندما يدعمها جهازك.

## ما الذي يقدمه

### دردشة للبرمجة

- اطلب تعديلات كود، بحثًا عن سبب bug، refactor، اختبارات، release notes أو توثيق.
- أضف مسارات ملفات أو اسحب الملفات إلى حقل الإدخال.
- راجع الإخراج المتدفق وسجلات الأوامر ومراجع الملفات والملخصات في واجهة دردشة واحدة.
- تابع بطلبات إضافية في نفس الجلسة.

### توجيه النماذج المجانية

- **20+ قناة بعيدة مع runtimes محلية**: NVIDIA NIM وOpenRouter وGitHub Models وHugging Face Router وSambaNova Cloud وTogether AI وGoogle Gemini وDeepSeek وMistral وMistral Codestral وOpenCode وWafer وKimi وCerebras وGroq وFireworks وZ.ai وLLM7 وKilo Gateway، بالإضافة إلى Ollama وLM Studio وllama.cpp.
- **مسارات تجريبية بدون key**: يمكن تجربة LLM7 وKilo Gateway بدون API key، لكنها مناسبة فقط لprompts برمجية غير حساسة.
- **مسارات رسمية بحصة مجانية أو تجريبية**: مفاتيح المزودين تحفظ محليًا داخل التطبيق.
- يقوم proxy المحلي المكتوب بRust بالترجمة بين بروتوكولات Anthropic وOpenAI-compatible.
- يمكن لClaude Code المرور عبر القنوات المجانية المضبوطة بدون تغيير واجهة الدردشة.
- تتم إدارة المفاتيح وتجاوزات النماذج والنماذج المحلية من الإعدادات.

النماذج الافتراضية الحالية الموجهة للبرمجة:

| القناة | النموذج الافتراضي |
| --- | --- |
| GitHub Models | `openai/gpt-4.1-mini` |
| Hugging Face Router | `deepseek-ai/DeepSeek-V4-Pro` |
| SambaNova Cloud | `DeepSeek-V3.1` |
| Together AI | `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` |
| Kilo Gateway | `poolside/laguna-xs.2:free` |
| LLM7 | `codestral-latest` |

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

### استخدام Chat للبرمجة

1. اضغط **+ New Session** في الشريط الجانبي.
2. اختر runtime وchannel ووضع الصلاحيات وworkspace من عناصر التحكم السفلية.
3. صف المهمة مع السلوك المطلوب والملفات المتأثرة ومعايير القبول والقيود.
4. أثناء التنفيذ يعرض FreeUltraCode قراءة الملفات والبحث والتعديلات والتحقق كعناصر منفصلة.
5. إذا احتجت إلى تعديل النتيجة، تابع في نفس الدردشة بطلب إضافي.

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
    lib/         إعدادات المزودين، توجيه القنوات المجانية، التخزين
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
