# Claude Code में Dynamic Workflows आ गए हैं। बाकी मॉडलों का क्या? OpenWorkflows एक ओपन-सोर्स विकल्प है

## हाल में मैं Claude Code के नए dynamic workflows को देख रहा हूं। MCP, Skill और Hooks की तुलना में इस नए फीचर पर बहुत कम चर्चा हुई है। आगे इन्हें मैं workflows कहूंगा।

जटिल कार्यों के लिए कई लोग पहले शोध वाला HTML बनाते थे, फिर उसे तकनीकी योजना वाले HTML में बदलते थे, और अंत में AI को विकास के लिए दे देते थे। लेकिन कई बार परिणाम अच्छे नहीं आते। मुख्य कारण यह है कि HTML इंसानों के पढ़ने के लिए टेक्स्ट है। यह Script नहीं है, और इसमें संरचित जानकारी कम होती है। क्रम की स्थिरता, कितना काम समानांतर चल सकता है, सीमाएं साफ हैं या नहीं, कार्य कैसे बांटे जाएं, और कार्य आपस में जानकारी कैसे बदलें, ये सब अस्पष्ट रहते हैं। इसलिए AI को बहुत कुछ अनुमान लगाना पड़ता है।

workflows खुद Script होते हैं, इसलिए वे इस समस्या को सीधे हल कर सकते हैं।

इसके अलावा workflows में कई कोणों से खोज, adversarial validation और योजना पर voting जैसी व्यवस्था भी होती है। इसी वजह से उनकी सटीकता अधिक हो सकती है। यह पैमाने से जीतने का तरीका है: एक ही समस्या पर पांच agents को एक साथ चलाएं, फिर एक और agent परिणामों का सारांश तैयार करता है। यह सच में अधिक सटीक होता है, लेकिन token भी तेजी से खर्च होते हैं।

जब यह इतना सामान्य उपयोगी है, तो इसे किसी एक मॉडल या एक CLI से क्यों बांधा जाए?

इसी सोच के आधार पर मैंने OpenWorkflows बनाया, या अधिक सही कहें तो AI ने बनाया। यह Claude Code जैसे workflows को visual canvas में बदलता है और कोशिश करता है कि वही flow Claude Code, Codex, Gemini और दूसरे local या cloud runtimes पर भी चल सके।

इस बार मैं अमूर्त अवधारणाओं की बात नहीं करूंगा। सीधे screenshots के हिसाब से चलूंगा। उदाहरण भी ठोस है: OpenWorkflows को कई interface styles का समर्थन देना, Pencil को default बनाना, और Settings / Appearance में style बदलने देना।

विकास के दौरान मैंने अधिक से अधिक काम OpenWorkflows के अंदर ही करने की कोशिश की, ताकि यह खुद को bootstrap कर सके।

नीचे की प्रक्रिया development के लिए CodeX को default large model के रूप में इस्तेमाल करती है।

### 0. पहले अंतिम interface देखें

<p align="center">
  <img src="images/0-标题使用.png" alt="OpenWorkflows main interface" width="960">
</p>

OpenWorkflows के main interface में बीच में workflows blueprint है, दाईं ओर node properties हैं, और नीचे AI input और output है।

मुख्य interface लगभग चार हिस्सों में बंटा है: बाईं ओर workflows history, बीच में visual canvas, दाईं ओर node properties और common prompts, और नीचे AI input तथा responses।

### 1. OpenWorkflows डाउनलोड करें

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

GitHub project page के दाईं ओर Releases से latest version खोजें।

### 2. पहले large model configure करें

Default रूप से यह system में configured CLI का उपयोग करके शुरू होगा। आप CC-Switch जैसी tools से इसे configure कर सकते हैं।

### 3. नया workflows बनाएं और request लिखें

<p align="center">
  <img src="images/3-新建workflow.png" alt="नया workflows बनाएं और request लिखें" width="840">
</p>

Model configure करने के बाद बाईं ओर "New workflows" पर click करें। Canvas पर एक minimal structure दिखेगा: Start, एक Agent, और End।

यहां सच में हाथ से nodes draw करने की जरूरत नहीं है। असली शुरुआत नीचे दाईं ओर AI input box से होती है। इस example में मैंने लिखा:

```text
मैं चाहता हूं कि OpenWorkflows कई interface styles support करे,
default में Pencil design इस्तेमाल करे,
और Settings / Appearance में इन्हें switch किया जा सके।
```

लिखने के बाद Ctrl+Enter दबा सकते हैं, या नीचे दाईं ओर send button दबा सकते हैं। OpenWorkflows इस natural language को editable workflows blueprint में बदल देता है।

### 4-1. workflows blueprint generate करें

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Generated workflows blueprint" width="960">
</p>

Request भेजने के बाद OpenWorkflows पहले current step को एक complete workflow में reorganize करता है।

Screenshot में blueprint लगभग ऐसा है:

```text
Start
  -> Appearance support plan को parallel में व्यवस्थित करें
      -> Existing appearance entry points research करें
      -> Multi-style system design करें
      -> Pencil default style design करें
  -> Implementation plan summarize करें
  -> Multiple interface styles implement करें
  -> Settings / Appearance switching जोड़ें
  -> Validation और regression checks करें
  -> Delivery result record करें
  -> End
```

दाईं ओर node properties में selected node की properties को आगे भी modify किया जा सकता है। लेकिन ज्यादातर समय नीचे के input box से AI को blueprint nodes modify करने को कहना अधिक स्वाभाविक है, ताकि लगातार iteration हो सके।

### 4-2. Generated script देखें

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="Generated workflows script" width="960">
</p>

ऊपर "Script" का entry point है। उसे खोलने पर current blueprint से generated script दिखता है।

Screenshot में parallel(...) और agent(...) जैसी structures दिखती हैं। Parallel nodes concurrent branches बनते हैं, और normal nodes अलग-अलग agent calls बनते हैं।

यह भी बताता है कि OpenWorkflows सिर्फ boxes draw नहीं कर रहा। Canvas के पीछे unified workflows structure है, इसलिए आगे अलग-अलग runtimes जोड़े जा सकते हैं।

### 5. दाईं ओर common prompts से आगे modify करें

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="Common prompts से workflows modify करें" width="960">
</p>

Blueprint generate होने के बाद तुरंत run करना जरूरी नहीं है। दाईं ओर "Common Prompts" process को polish करने के लिए ज्यादा उपयुक्त हैं, हालांकि आप खुद भी लिख सकते हैं।

Prompts scenario के हिसाब से grouped हैं, जैसे interactive clarification, clarity, completeness, cost, structure, reliability, performance and parallelism, verification and testing।

Screenshot में "Clarify Requirements" चुना गया है। यह AI input box में एक prompt भरता है, जो AI से कहता है कि blueprint modify करने से पहले key ambiguities को interactive तरीके से confirm करे।

यह design बहुत practical है। कई workflows इसलिए fail नहीं होते कि model काम नहीं कर सकता, बल्कि इसलिए कि goal, boundaries, failure paths और cost strategy शुरुआत में साफ नहीं होती।

इसके अलावा grill-me, boundary conditions complete करना, parallel optimization, single principle जैसे common prompts भी हैं। आप खुद prompts जोड़ या modify कर सकते हैं।

### 6. Interactive choices से boundary confirm करें

<p align="center">
  <img src="images/6-交互选择.png" alt="Interactive choices से boundary confirm करें" width="640">
</p>

"Clarify Requirements" दबाने के बाद AI सीधे graph modify नहीं करता। वह पहले पूछता है: "Interface style switching feature किस scope तक implement होना चाहिए?"

Screenshot में दो options हैं: सिर्फ Pencil default style implement करके extension structure छोड़ना, या Pencil सहित कई switchable styles implement करना।

आपके चुनने के बाद AI इस decision को workflows blueprint में वापस लिखता है और updated IRGraph output करता है। यह step AI के अपने-आप गलत direction में जाने की समस्या को कम करता है।

### 7. Run पर click करें

<p align="center">
  <img src="images/7-运行.png" alt="workflows run करें" width="960">
</p>

Blueprint structure, model configuration और key boundaries confirm होने के बाद ऊपर "Run" दबाएं।

Blueprint generate होते ही run करना अच्छा नहीं है। पहले देखें कि parallel branches सही हैं या नहीं, summary node parallel branches के बाद है या नहीं, और validation final result को cover करती है या नहीं।

अगर किसी node की responsibility बस unclear है, तो पहले node properties में modify करके फिर run करें।

### 8. Running state देखें

<p align="center">
  <img src="images/8-运行中.png" alt="workflows running state देखें" width="960">
</p>

Run करने के बाद top button "Running... Stop" में बदल जाता है। नीचे AI input lock हो जाता है, ताकि execution के दौरान blueprint गड़बड़ न हो।

Canvas पर node status दिखता है। Screenshot में Start complete है, बाद वाला parallel node running है, और top-right में run count भी है। बीच में failure हो जाए तो previous task से आगे continue किया जा सकता है।

### 9. Interface style switch करें

<p align="center">
  <img src="images/9-切换风格.png" alt="Interface style switch करें" width="840">
</p>

OpenWorkflows development complete होने के बाद program restart करें, और Settings / Appearance में अलग-अलग appearance styles switch करें।

Screenshot में Pencil, Deep Night, Aurora, Daylight, Ember जैसे style cards दिखते हैं। किसी style को चुनने पर global background, panels, borders और run-state colors बदलते हैं।

### मुझे जो सच में उपयोगी लगता है

OpenWorkflows की सबसे बड़ी value prompt के ऊपर UI लगाने में नहीं है।

यह "request -> blueprint -> script -> run -> history review" को जोड़ता है। आप पहले natural language से process generate कर सकते हैं, फिर canvas पर structure check कर सकते हैं, जरूरत हो तो common prompts से boundaries भर सकते हैं, और अंत में run कर सकते हैं।

एक ही workflows को naturally एक model से बंधा होने की जरूरत नहीं है। Simple nodes सस्ते models इस्तेमाल कर सकते हैं, key nodes मजबूत models इस्तेमाल कर सकते हैं, और execution target आगे Claude Code, Codex, Gemini या दूसरे runtimes तक expand हो सकता है।

Complex AI coding tasks के लिए यह तरीका एक बहुत लंबे prompt से ज्यादा maintainable है। कोई node fail हो तो वही node सुधारें। कोई branch जरूरी न हो तो branch delete करें। Reuse करना हो तो history से continue करें।

### अभी शुरुआती है, लेकिन दिशा देखने लायक है

workflows का पूरा concept अभी काफी शुरुआती है, और OpenWorkflows भी अभी शुरू ही हुआ है। Runtime adapters, node capabilities और script ecosystem बदलते रहेंगे।

लेकिन overall direction साफ है: AI coding लंबे समय तक "chat box खोलो और हर step manually आगे बढ़ाओ" तक सीमित नहीं रहेगी।

Complex tasks आखिरकार workflows बनेंगे, क्योंकि वे देखे, edit किए, migrate किए और reuse किए जा सकते हैं।

QQ group: 149523963

Project:

https://github.com/wellingfeng/OpenWorkflows

Reference:

https://code.claude.com/docs/en/workflows
