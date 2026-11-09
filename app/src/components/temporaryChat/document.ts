// Moon Begin: isolated, text-only chat surface. No UGS runtime or provider imports.
import { renderTemporaryChatMarkdown } from './markdown';
import katexSource from 'katex/dist/katex.min.js?raw';

export const TEMPORARY_CHAT_SANDBOX = 'allow-scripts';
export const TEMPORARY_CHAT_PERMISSIONS = [
  'camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read',
  'clipboard-write', 'usb', 'serial', 'hid', 'bluetooth', 'local-fonts',
  'payment', 'publickey-credentials-get', 'publickey-credentials-create',
].map((permission) => `${permission} 'none'`).join('; ');

export function temporaryChatDocument({ fileTab = false }: { fileTab?: boolean } = {}): string {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;background:#131314;color:#e3e3e3;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;padding:0 10px 10px;color-scheme:dark}
main{flex:1;min-height:0;overflow:auto;padding:16px 6px;scrollbar-width:thin;overflow-wrap:anywhere}
h1{font-size:18px;font-weight:500;line-height:1.5;margin:0 0 7px}p{margin:0;color:#96969c;font-size:12px}
.composer{position:relative;flex-shrink:0;background:#202022;border:1px solid #303033;border-radius:20px;padding:12px 12px 8px}
.composer:focus-within{border-color:#56565d}
.composer-resize{position:absolute;z-index:1;top:-5px;left:14px;right:14px;height:11px;cursor:ns-resize;touch-action:none}.composer-resize:hover::after,.composer-resize:focus-visible::after{content:"";position:absolute;top:5px;left:0;right:0;border-top:2px solid #a8c7fa}.composer-resize:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
.reference{display:flex;align-items:center;gap:7px;margin:0 0 10px;padding:6px 8px;border-radius:10px;background:#303137;color:#cbd9f4;font-size:11px;line-height:1.4}.reference[hidden]{display:none}.reference-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reference button{width:22px;height:22px;font-size:17px}
textarea{display:block;flex:1;min-width:0;resize:none;width:0;height:64px;max-height:128px;max-height:min(128px,40vh);min-height:64px;padding:0;border:0;outline:0;background:none;color:#ececef;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;scrollbar-width:thin}
textarea::placeholder{color:#a0a0a6}
.input-row{display:flex;align-items:flex-end;gap:6px;min-height:28px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
button{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;padding:0;font:inherit;border:0;border-radius:50%;cursor:pointer;color:#b8b8bf;background:transparent}
button:hover{background:#36363a;color:#eee}button:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
button:disabled{color:#828289;background:#303034;cursor:not-allowed}button[hidden],.count[hidden]{display:none}
svg{display:block;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.count{font-size:10px;color:#a3a3aa;font-variant-numeric:tabular-nums}
.models{display:flex;align-items:center;gap:4px;padding:0 3px 6px;flex-shrink:0}select{width:100%;min-width:0;background:#131314;color:#aeb2bc;border:0;font:11px system-ui;outline-offset:2px}select:focus-visible{outline:1px solid #a8c7fa}.models button{width:24px;height:24px;font-size:15px}
.session-toolbar{display:flex;align-items:center;gap:5px;position:relative;flex-shrink:0;padding:0 0 4px}.session-toolbar .session-toggle{display:flex;width:auto;gap:5px;padding:0 8px;border-radius:8px;font-size:12px}.session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#96969c;font-size:11px}.session-toolbar .session-new{font-size:20px}.session-menu{position:absolute;z-index:3;top:32px;left:0;right:0;max-height:min(300px,55vh);overflow:auto;padding:5px;background:#232326;border:1px solid #424247;border-radius:10px;box-shadow:0 8px 24px #0009}.session-menu[hidden]{display:none}.session-row{display:flex;align-items:center;gap:2px;border-radius:7px}.session-row[data-active=true]{background:#34383f}.session-row .session-open{display:block;flex:1;width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:0 8px;border-radius:7px;font-size:12px}.session-row .session-delete{width:26px;font-size:17px}.session-row .session-confirm,.session-row .session-cancel{width:auto;padding:0 6px;border-radius:6px;font-size:11px}.session-confirm{color:#f2aaa5}
.message{white-space:pre-wrap;font-size:13px;line-height:1.7}.user{margin:0 0 14px 28px;background:#29292d;border-radius:14px 14px 3px 14px;padding:8px 12px}.assistant{margin:0 0 4px;padding:0 4px}.turn{margin-bottom:18px}.turn-actions{display:flex;gap:8px;align-items:center}.turn-actions button{display:inline-block;width:auto;height:24px;border-radius:6px;font-size:11px;padding:0 6px;color:#a3a3aa}.error{color:#e5a9a5;font-size:11px;white-space:pre-wrap;margin:6px 4px}.stopped{color:#96969c;font-size:11px}.global-error{flex-shrink:0;max-height:60px;overflow:auto}.send:not(:disabled){background:#a8c7fa;color:#15243e}
.assistant{white-space:normal}.assistant>:first-child{margin-top:0}.assistant>:last-child{margin-bottom:0}.assistant p,.assistant ul,.assistant ol,.assistant pre,.assistant blockquote,.assistant .table{margin:0 0 10px}.assistant h1,.assistant h2,.assistant h3,.assistant h4,.assistant h5,.assistant h6{color:#ececef;font-weight:600;line-height:1.45;margin:14px 0 6px}.assistant h1{font-size:17px}.assistant h2{font-size:16px}.assistant h3{font-size:15px}.assistant h4,.assistant h5,.assistant h6{font-size:13px}.assistant ul,.assistant ol{padding-left:20px}.assistant li{margin:3px 0}.assistant li>ul,.assistant li>ol,.assistant li>p{margin:4px 0}.assistant strong{color:#f1f1f4;font-weight:600}.assistant code{font:12px/1.5 Consolas,"Cascadia Mono",monospace;background:#2a2a2e;border-radius:4px;padding:1px 4px}.assistant pre{background:#1d1d20;border:1px solid #303033;border-radius:8px;padding:8px 10px;overflow:auto;white-space:pre}.assistant pre code{background:none;padding:0}.assistant blockquote{border-left:3px solid #44444a;padding-left:10px;color:#b4b4ba}.assistant hr{border:0;border-top:1px solid #333337;margin:14px 0}.assistant .table{overflow:auto}.assistant table{border-collapse:collapse;font-size:12px}.assistant th,.assistant td{border:1px solid #3a3a3f;padding:4px 8px;text-align:left}.assistant th{background:#232326}.assistant .link{color:#a8c7fa;text-decoration:underline}
.assistant math{font-family:"Cambria Math","STIX Two Math",math}.assistant .math-display{display:block;overflow-x:auto;overflow-y:hidden;margin:8px 0}.assistant .math-display math{min-width:100%}
</style></head><body>
<div class="session-toolbar"><button class="session-toggle" type="button" aria-label="会话列表" aria-expanded="false">☰ 会话</button><span class="session-title"></span><button class="session-new" type="button" aria-label="新建会话" title="新建会话">＋</button><div class="session-menu" aria-label="随手聊会话列表" hidden></div></div>
<div class="models"><select aria-label="聊天模型" disabled><option>正在读取渠道…</option></select><button id="refresh" title="刷新渠道" aria-label="刷新渠道">↻</button></div>
<main role="log" aria-label="临时聊天信息流"><h1>有什么想聊的？</h1><p>${fileTab ? '当前文件的会话会保存在本地。' : '当前内容的会话会保存在本地。'}</p></main>
<div class="global-error error" role="alert" hidden></div>
<div class="storage-error error" role="alert" hidden></div>
<div class="composer"><div class="composer-resize" role="separator" aria-label="拖动调整输入框高度" aria-orientation="horizontal" aria-valuemin="64" aria-valuenow="64" tabindex="0" title="拖动调整输入框高度"></div><div class="reference" hidden><span aria-hidden="true">✦</span><span class="reference-label"></span><button id="remove-reference" type="button" aria-label="移除引用" title="移除引用">×</button></div><div class="input-row"><textarea aria-label="临时聊天输入" aria-describedby="connection-status" maxlength="20000" placeholder="输入问题…"></textarea>
<span id="connection-status" class="sr-only" role="status">正在读取渠道…</span>
<span class="count" aria-live="polite" hidden></span>
<button id="clear" type="button" aria-label="清空草稿" title="清空草稿" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button>
<button id="send" class="send" type="button" aria-label="发送" disabled title="发送（Enter）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
</div></div>
<script nonce="${nonce}">
const temporaryKatex=(()=>{const module={exports:{}};const exports=module.exports;${katexSource};return module.exports;})();
const input=document.querySelector('textarea');
const resizeHandle=document.querySelector('.composer-resize');
const count=document.querySelector('.count');
const clear=document.querySelector('#clear');
const send=document.querySelector('#send');
const main=document.querySelector('main');
const models=document.querySelector('select');
const status=document.querySelector('#connection-status');
const sessionToggle=document.querySelector('.session-toggle');
const sessionMenu=document.querySelector('.session-menu');
const sessionTitle=document.querySelector('.session-title');
const drafts=new Map();
let confirmDelete='';
let state={models:[],selected:0,turns:[],busy:false,status:'正在读取渠道…',error:'',sessions:[],sessionId:'',storageError:''};
let sentDraft=null;
let visibleScroll=0;
let pendingScroll=null;
let wasHidden=false;
const post=(type,extra={})=>parent.postMessage({scope:'ugs-temporary-chat',type,...extra},'*');
function restoreScroll(){
  if(!main.clientHeight){wasHidden=true;return;}
  if(pendingScroll!==null){main.scrollTop=pendingScroll==='bottom'?main.scrollHeight:pendingScroll;pendingScroll=null;}
  else if(wasHidden)main.scrollTop=visibleScroll;
  visibleScroll=main.scrollTop;wasHidden=false;
}
function updateStatus(){status.textContent=state.status;}
let preferredInputHeight=null;
let resizeDrag=null;
function inputMaxHeight(){const overflow=Math.max(0,document.body.scrollHeight-document.documentElement.clientHeight);return Math.max(64,input.getBoundingClientRect().height+main.getBoundingClientRect().height-80-overflow);}
function fitInput(){
  if(preferredInputHeight===null){input.style.maxHeight='';input.style.height='64px';input.style.height=input.scrollHeight+'px';}
  else if(input.getClientRects().length){input.style.maxHeight='none';input.style.height=Math.min(preferredInputHeight,inputMaxHeight())+'px';}
  if(input.getClientRects().length){resizeHandle.setAttribute('aria-valuenow',String(Math.round(input.getBoundingClientRect().height)));resizeHandle.setAttribute('aria-valuemax',String(Math.round(inputMaxHeight())));}
}
function resizeInput(height){preferredInputHeight=Math.max(64,Math.min(height,inputMaxHeight()));fitInput();}
resizeHandle.addEventListener('pointerdown',event=>{
  if(event.button!==0||resizeDrag)return;
  event.preventDefault();
  resizeDrag={pointerId:event.pointerId,startY:event.clientY,startHeight:input.getBoundingClientRect().height,previous:preferredInputHeight};
  resizeHandle.setPointerCapture(event.pointerId);
});
resizeHandle.addEventListener('pointermove',event=>{if(resizeDrag&&event.pointerId===resizeDrag.pointerId)resizeInput(resizeDrag.startHeight+resizeDrag.startY-event.clientY);});
resizeHandle.addEventListener('pointerup',event=>{if(resizeDrag&&event.pointerId===resizeDrag.pointerId)resizeDrag=null;});
function cancelResize(event){if(resizeDrag&&event.pointerId===resizeDrag.pointerId){preferredInputHeight=resizeDrag.previous;resizeDrag=null;fitInput();}}
resizeHandle.addEventListener('pointercancel',cancelResize);
resizeHandle.addEventListener('lostpointercapture',cancelResize);
resizeHandle.addEventListener('keydown',event=>{
  if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
  event.preventDefault();resizeInput(input.getBoundingClientRect().height+(event.key==='ArrowUp'?1:-1)*(event.shiftKey?50:10));
});
function updateDraft(){
  count.hidden=input.value.length<18000;
  count.textContent=count.hidden?'':input.value.length+' / 20000';
  clear.hidden=input.value.length===0;
  send.disabled=!state.busy&&(state.historyLoading||!state.models.length||!input.value.trim()||(state.reference&&state.reference.status!=='ready'));
  fitInput();
}
function submit(){if(state.busy){post('stop');return;}if(state.historyLoading||!input.value.trim()||!state.models.length||(state.reference&&state.reference.status!=='ready'))return;sentDraft=input.value;post('send',{text:input.value});}
function textNode(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text;return node;}
const renderMarkdown=${renderTemporaryChatMarkdown.toString()};
function markdownNode(className,text){const node=document.createElement('div');node.className=className;try{node.append(renderMarkdown(document,text,(target,formula,display)=>temporaryKatex.render(formula,target,{output:'mathml',displayMode:display,throwOnError:false,trust:false})));}catch{node.textContent=text;node.style.whiteSpace='pre-wrap';}return node;}
function copy(text,button){const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;left:-9999px';document.body.append(field);field.select();try{button.textContent=document.execCommand('copy')?'已复制':'复制失败';}catch{button.textContent='复制失败';}field.remove();input.focus();}
function closeSessions(){sessionMenu.hidden=true;sessionToggle.setAttribute('aria-expanded','false');confirmDelete='';}
function renderSessions(){
  const signature=JSON.stringify([state.sessions,state.sessionId,confirmDelete]);
  if(sessionMenu.dataset.signature===signature)return;
  sessionMenu.dataset.signature=signature;sessionMenu.replaceChildren();
  state.sessions.forEach(session=>{
    const row=textNode('div','session-row','');row.dataset.active=String(session.id===state.sessionId);
    const open=textNode('button','session-open',session.title);open.type='button';open.title=session.title;open.setAttribute('aria-label','打开会话：'+session.title);
    open.onclick=()=>{post('select-session',{id:session.id});closeSessions();};row.append(open);
    if(confirmDelete===session.id){
      const yes=textNode('button','session-confirm','确认删除');yes.type='button';yes.onclick=()=>{post('delete-session',{id:session.id});confirmDelete='';};
      const no=textNode('button','session-cancel','取消');no.type='button';no.onclick=()=>{confirmDelete='';renderSessions();};row.append(yes,no);
    }else{
      const remove=textNode('button','session-delete','×');remove.type='button';remove.title='删除会话';remove.setAttribute('aria-label','删除会话：'+session.title);
      remove.onclick=()=>{confirmDelete=session.id;renderSessions();};row.append(remove);
    }
    sessionMenu.append(row);
  });
  sessionTitle.textContent=state.sessions.find(session=>session.id===state.sessionId)?.title||'新会话';
  sessionTitle.title=sessionTitle.textContent;
}
function render(sessionChanged=false){
  const visible=main.clientHeight>0&&!wasHidden;
  const nearBottom=visible&&main.scrollHeight-main.scrollTop-main.clientHeight<64;
  const previousScroll=visible?main.scrollTop:visibleScroll;
  const nextScroll=sessionChanged?(typeof state.scrollTop==='number'?state.scrollTop:'bottom'):(pendingScroll!==null?pendingScroll:nearBottom?'bottom':previousScroll);
  if(state.turns.length){main.replaceChildren();state.turns.forEach((turn,index)=>{
    const block=textNode('section','turn','');
    block.append(textNode('div','message user',turn.user));
    block.append(turn.assistant?markdownNode('message assistant',turn.assistant):textNode('div','message assistant',turn.status==='running'?'正在思考…':''));
    if(turn.error)block.append(textNode('div','error',turn.error));
    const actions=textNode('div','turn-actions','');
    if(turn.assistant){const button=textNode('button','','复制');button.setAttribute('aria-label','复制回答 '+(index+1));button.onclick=()=>copy(turn.assistant,button);actions.append(button);}
    if(turn.status==='stopped')actions.append(textNode('span','stopped','已停止'));
    if(index===state.turns.length-1&&!state.busy&&(turn.status==='error'||turn.status==='stopped')){const button=textNode('button','','重试');button.setAttribute('aria-label','重试');button.onclick=()=>post('retry');actions.append(button);}
    block.append(actions);main.append(block);
  });}else{main.replaceChildren(textNode('h1','','有什么想聊的？'),textNode('p','',${JSON.stringify(fileTab ? '当前文件的会话会保存在本地。' : '当前内容的会话会保存在本地。')}));}
  const signature=JSON.stringify(state.models);
  if(models.dataset.signature!==signature){models.replaceChildren();state.models.forEach((model,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=model.label;models.append(option);});if(!state.models.length)models.append(textNode('option','','无可用渠道'));models.dataset.signature=signature;}
  models.value=String(state.selected);models.disabled=state.busy||!state.models.length;models.title=state.models[state.selected]?.label||'在设置中配置模型渠道';
  document.querySelector('#refresh').disabled=state.busy;
  const error=document.querySelector('.global-error');error.textContent=state.error;error.hidden=!state.error;
  const storageError=document.querySelector('.storage-error');storageError.textContent=state.storageError;storageError.hidden=!state.storageError;
  const reference=document.querySelector('.reference');reference.hidden=!state.reference;
  if(state.reference){const r=state.reference;const label=document.querySelector('.reference-label');label.textContent=(r.status==='loading'?'正在读取：':r.status==='error'?'读取失败：':'正在引用：')+r.label+(r.note?' · '+r.note:'');label.title=label.textContent;document.querySelector('#remove-reference').disabled=state.busy;}
  send.setAttribute('aria-label',state.busy?'停止生成':'发送');send.title=state.busy?'停止生成':'发送（Enter）';
  send.innerHTML=state.busy?'<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>':'<svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  document.querySelector('.session-toggle').disabled=!!state.historyLoading;document.querySelector('.session-new').disabled=!!state.historyLoading;
  renderSessions();updateStatus();updateDraft();pendingScroll=nextScroll;restoreScroll();
}
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.scope!=='ugs-temporary-chat'||event.data?.type!=='state')return;
  const next=event.data.state;
  if(!next||!Array.isArray(next.turns)||!Array.isArray(next.models))return;
  const sessionChanged=next.sessionId!==state.sessionId;
  if(sessionChanged){if(state.sessionId)drafts.set(state.sessionId,input.value);input.value=drafts.get(next.sessionId)||'';sentDraft=null;confirmDelete='';}
  if(next.busy&&!state.busy){if(sentDraft!==null&&input.value===sentDraft){input.value='';}sentDraft=null;}
  state=next;render(sessionChanged);
});
main.addEventListener('scroll',()=>{if(!state.sessionId||state.historyLoading||!main.clientHeight||wasHidden||pendingScroll!==null)return;visibleScroll=main.scrollTop;post('scroll',{id:state.sessionId,position:visibleScroll});});
if(typeof ResizeObserver==='function')new ResizeObserver(restoreScroll).observe(main);
models.addEventListener('change',()=>post('select',{index:Number(models.value)}));
sessionToggle.addEventListener('click',()=>{sessionMenu.hidden=!sessionMenu.hidden;sessionToggle.setAttribute('aria-expanded',String(!sessionMenu.hidden));if(!sessionMenu.hidden)renderSessions();});
document.querySelector('.session-new').addEventListener('click',()=>{post('new-session');closeSessions();input.focus();});
document.addEventListener('click',event=>{if(!event.composedPath().includes(document.querySelector('.session-toolbar')))closeSessions();});
document.querySelector('#refresh').addEventListener('click',()=>post('refresh'));
document.querySelector('#remove-reference').addEventListener('click',()=>post('remove-context'));
send.addEventListener('click',submit);
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!state.busy)submit();}});
input.addEventListener('input',updateDraft);
window.addEventListener('resize',()=>{fitInput();restoreScroll();});
clear.addEventListener('click',()=>{input.value='';updateDraft();input.focus();});
document.addEventListener('dragover',event=>event.preventDefault());
document.addEventListener('drop',event=>event.preventDefault());
document.addEventListener('paste',event=>{if([...event.clipboardData.items].some(item=>item.kind==='file'))event.preventDefault();});
input.focus();post('ready');
</script></body></html>`;
}
// Moon End
