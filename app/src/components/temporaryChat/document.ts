// Moon Begin: isolated, text-only chat surface. No UGS runtime or provider imports.
export const TEMPORARY_CHAT_SANDBOX = 'allow-scripts';
export const TEMPORARY_CHAT_PERMISSIONS = [
  'camera', 'microphone', 'geolocation', 'display-capture', 'clipboard-read',
  'clipboard-write', 'usb', 'serial', 'hid', 'bluetooth', 'local-fonts',
  'payment', 'publickey-credentials-get', 'publickey-credentials-create',
].map((permission) => `${permission} 'none'`).join('; ');

export function temporaryChatDocument(): string {
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
.composer{flex-shrink:0;background:#202022;border:1px solid #303033;border-radius:20px;padding:12px 12px 8px}
.composer:focus-within{border-color:#56565d}
.reference{display:flex;align-items:center;gap:7px;margin:0 0 10px;padding:6px 8px;border-radius:10px;background:#303137;color:#cbd9f4;font-size:11px;line-height:1.4}.reference[hidden]{display:none}.reference-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reference button{width:22px;height:22px;font-size:17px}
textarea{display:block;resize:none;width:100%;height:28px;max-height:128px;max-height:min(128px,40vh);min-height:28px;padding:0;border:0;outline:0;background:none;color:#ececef;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;scrollbar-width:thin}
textarea::placeholder{color:#a0a0a6}
.actions{display:flex;align-items:center;gap:6px;margin-top:10px;min-height:28px}
.status{display:flex;align-items:center;gap:5px;flex:1;min-width:0;color:#a3a3aa;font-size:11px;white-space:nowrap}
.status::before{content:'';width:5px;height:5px;border:1px solid currentColor;border-radius:50%}
button{display:grid;place-items:center;flex-shrink:0;width:28px;height:28px;padding:0;font:inherit;border:0;border-radius:50%;cursor:pointer;color:#b8b8bf;background:transparent}
button:hover{background:#36363a;color:#eee}button:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
button:disabled{color:#828289;background:#303034;cursor:not-allowed}button[hidden],.count[hidden]{display:none}
svg{display:block;width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.count{font-size:10px;color:#a3a3aa;font-variant-numeric:tabular-nums}
.models{display:flex;align-items:center;gap:4px;padding:0 3px 6px;flex-shrink:0}select{width:100%;min-width:0;background:#131314;color:#aeb2bc;border:0;font:11px system-ui;outline-offset:2px}select:focus-visible{outline:1px solid #a8c7fa}.models button{width:24px;height:24px;font-size:15px}
.message{white-space:pre-wrap;font-size:13px;line-height:1.7}.user{margin:0 0 14px 28px;background:#29292d;border-radius:14px 14px 3px 14px;padding:8px 12px}.assistant{margin:0 0 4px;padding:0 4px}.turn{margin-bottom:18px}.turn-actions{display:flex;gap:8px;align-items:center}.turn-actions button{display:inline-block;width:auto;height:24px;border-radius:6px;font-size:11px;padding:0 6px;color:#a3a3aa}.error{color:#e5a9a5;font-size:11px;white-space:pre-wrap;margin:6px 4px}.stopped{color:#96969c;font-size:11px}.global-error{flex-shrink:0;max-height:60px;overflow:auto}.send:not(:disabled){background:#a8c7fa;color:#15243e}.status{overflow:hidden;text-overflow:ellipsis;display:block}.status::before{display:none}
</style></head><body>
<div class="models"><select aria-label="聊天模型" disabled><option>正在读取渠道…</option></select><button id="refresh" title="刷新渠道" aria-label="刷新渠道">↻</button></div>
<main role="log" aria-label="临时聊天信息流"><h1>有什么想聊的？</h1><p>独立会话，关闭即清除。</p></main>
<div class="global-error error" role="alert" hidden></div>
<div class="composer"><div class="reference" hidden><span aria-hidden="true">✦</span><span class="reference-label"></span><button id="remove-reference" type="button" aria-label="移除引用" title="移除引用">×</button></div><textarea aria-label="临时聊天输入" aria-describedby="connection-status" maxlength="20000" placeholder="输入问题…"></textarea>
<div class="actions">
<span id="connection-status" class="status" role="status">正在读取渠道…</span>
<span class="count" aria-live="polite" hidden></span>
<button id="clear" type="button" aria-label="清空草稿" title="清空草稿" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg></button>
<button id="send" class="send" type="button" aria-label="发送" disabled title="发送（Enter）"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
</div></div>
<script nonce="${nonce}">
const input=document.querySelector('textarea');
const count=document.querySelector('.count');
const clear=document.querySelector('#clear');
const send=document.querySelector('#send');
const main=document.querySelector('main');
const models=document.querySelector('select');
const status=document.querySelector('.status');
let state={models:[],selected:0,turns:[],busy:false,status:'正在读取渠道…',error:''};
let sentDraft=null;
let startedAt=0;
const post=(type,extra={})=>parent.postMessage({scope:'ugs-temporary-chat',type,...extra},'*');
function updateStatus(){status.textContent=state.status+(state.busy?' · '+Math.floor((Date.now()-startedAt)/1000)+'秒':'');status.title=status.textContent;}
setInterval(updateStatus,1000);
function fitInput(){input.style.height='28px';input.style.height=input.scrollHeight+'px';}
function updateDraft(){
  count.hidden=input.value.length<18000;
  count.textContent=count.hidden?'':input.value.length+' / 20000';
  clear.hidden=input.value.length===0;
  send.disabled=!state.busy&&(!state.models.length||!input.value.trim()||(state.reference&&state.reference.status!=='ready'));
  fitInput();
}
function submit(){if(state.busy){post('stop');return;}if(!input.value.trim()||!state.models.length||(state.reference&&state.reference.status!=='ready'))return;sentDraft=input.value;post('send',{text:input.value});}
function textNode(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text;return node;}
function copy(text,button){const field=document.createElement('textarea');field.value=text;field.style.cssText='position:fixed;left:-9999px';document.body.append(field);field.select();try{button.textContent=document.execCommand('copy')?'已复制':'复制失败';}catch{button.textContent='复制失败';}field.remove();input.focus();}
function render(){
  const nearBottom=main.scrollHeight-main.scrollTop-main.clientHeight<64;
  const previousScroll=main.scrollTop;
  if(state.turns.length){main.replaceChildren();state.turns.forEach((turn,index)=>{
    const block=textNode('section','turn','');
    block.append(textNode('div','message user',turn.user));
    block.append(textNode('div','message assistant',turn.assistant||(turn.status==='running'?'正在思考…':'')));
    if(turn.error)block.append(textNode('div','error',turn.error));
    const actions=textNode('div','turn-actions','');
    if(turn.assistant){const button=textNode('button','','复制');button.setAttribute('aria-label','复制回答 '+(index+1));button.onclick=()=>copy(turn.assistant,button);actions.append(button);}
    if(turn.status==='stopped')actions.append(textNode('span','stopped','已停止'));
    if(index===state.turns.length-1&&!state.busy&&(turn.status==='error'||turn.status==='stopped')){const button=textNode('button','','重试');button.setAttribute('aria-label','重试');button.onclick=()=>post('retry');actions.append(button);}
    block.append(actions);main.append(block);
  });}
  if(nearBottom)main.scrollTop=main.scrollHeight;else main.scrollTop=previousScroll;
  const signature=JSON.stringify(state.models);
  if(models.dataset.signature!==signature){models.replaceChildren();state.models.forEach((model,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=model.label;models.append(option);});if(!state.models.length)models.append(textNode('option','','无可用渠道'));models.dataset.signature=signature;}
  models.value=String(state.selected);models.disabled=state.busy||!state.models.length;models.title=state.models[state.selected]?.label||'在设置中配置模型渠道';
  document.querySelector('#refresh').disabled=state.busy;
  const error=document.querySelector('.global-error');error.textContent=state.error;error.hidden=!state.error;
  const reference=document.querySelector('.reference');reference.hidden=!state.reference;
  if(state.reference){const r=state.reference;const label=document.querySelector('.reference-label');label.textContent=(r.status==='loading'?'正在读取：':r.status==='error'?'读取失败：':'正在引用：')+r.label+(r.note?' · '+r.note:'');label.title=label.textContent;document.querySelector('#remove-reference').disabled=state.busy;}
  send.setAttribute('aria-label',state.busy?'停止生成':'发送');send.title=state.busy?'停止生成':'发送（Enter）';
  send.innerHTML=state.busy?'<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>':'<svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
  updateStatus();updateDraft();
}
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.scope!=='ugs-temporary-chat'||event.data?.type!=='state')return;
  const next=event.data.state;
  if(!next||!Array.isArray(next.turns)||!Array.isArray(next.models))return;
  if(next.busy&&!state.busy){startedAt=Date.now();if(sentDraft!==null&&input.value===sentDraft){input.value='';}sentDraft=null;}
  state=next;render();
});
models.addEventListener('change',()=>post('select',{index:Number(models.value)}));
document.querySelector('#refresh').addEventListener('click',()=>post('refresh'));
document.querySelector('#remove-reference').addEventListener('click',()=>post('remove-context'));
send.addEventListener('click',submit);
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!state.busy)submit();}});
input.addEventListener('input',updateDraft);
window.addEventListener('resize',fitInput);
clear.addEventListener('click',()=>{input.value='';updateDraft();input.focus();});
document.addEventListener('dragover',event=>event.preventDefault());
document.addEventListener('drop',event=>event.preventDefault());
document.addEventListener('paste',event=>{if([...event.clipboardData.items].some(item=>item.kind==='file'))event.preventDefault();});
input.focus();post('ready');
</script></body></html>`;
}
// Moon End
