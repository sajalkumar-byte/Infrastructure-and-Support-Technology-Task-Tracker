/* view.js – pure rendering: HTML templates, modals, status line, toasts
   Part of the MVP split: js/model.js · js/view.js · js/presenter.js (loaded in that order)
   UI framework: Bootstrap 5.3 (grid, cards, nav pills, forms, modals, toasts, badges, progress) */

/* ============================== VIEW =============================== */
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fd=s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—';
const badge=s=>`<span class="badge rounded-pill b" style="--c:${COL[s]||'#94a3b8'}">${esc(s)}</span>`;
const avc=n=>{let h=0;for(const ch of String(n))h=(h*31+ch.charCodeAt(0))%360;return `hsl(${h} 62% 46%)`};
const {base,over}=Model;const pct=p=>Model.pct(p);const own=p=>Model.own(p);
const shortTime=iso=>{if(!iso)return '';const d=new Date(iso);if(isNaN(d))return '';
 const today=new Date();const sameDay=d.toDateString()===today.toDateString();
 return sameDay?d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
               :d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})};
const bar=(g,c,h=4,live)=>`<div class="progress mt-2" style="height:${h}px"><div class="progress-bar ${live?'progress-bar-striped progress-bar-animated':''}" style="width:${g||0}%;background:${c}"></div></div>`;
const card=(c,body,cls='')=>`<div class="card tcard h-100 ${cls}" style="--c:${c}"><div class="card-body">${body}</div></div>`;
const sec=(c,t)=>`<h3 class="sec" style="--c:${c}">${t}</h3>`;
const empty=t=>`<p class="text-secondary small mb-0">${t}</p>`;
/* export buttons: what gets exported is decided by the Presenter from the current page + filters */
const xbtns=hint=>!Model.can('export')?'':`<div class="btn-group xp" role="group" aria-label="Export" title="${esc(hint||'Download or print the data shown on this page')}"><button class="btn btn-outline-secondary" data-a="export" data-v="pdf" data-bs-toggle="tooltip" title="Download as PDF">⬇ PDF</button><button class="btn btn-outline-secondary" data-a="export" data-v="xlsx" data-bs-toggle="tooltip" title="Download as Excel">⬇ Excel</button><button class="btn btn-outline-secondary" data-a="export" data-v="print" data-bs-toggle="tooltip" title="Print">🖨 Print</button></div>`;

const View={
 toast(m){const t=document.createElement('div');t.className='toast align-items-center text-bg-dark border-0';t.setAttribute('role','status');
  t.innerHTML=`<div class="d-flex"><div class="toast-body"></div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
  t.querySelector('.toast-body').textContent=m;$('#toasts').appendChild(t);t.addEventListener('hidden.bs.toast',()=>t.remove());new bootstrap.Toast(t,{delay:2200}).show()},
 /* The flying overdue message. It names what is late and how late, offers the overdue list,
    and leaves on its own - or when dismissed, or while the pointer rests on it, not at all. */
 flyOverdue(list,total){
  const box=$('#fly');if(!box)return;
  const days=p=>Math.max(1,Math.round((today-new Date(p.e+'T00:00:00'))/86400000));
  const rows=list.slice(0,3).map(p=>`<li><span class="text-truncate"><span class="id">${esc(p.id)}</span> ${esc(p.title)}</span><b class="text-nowrap">${days(p)} day${days(p)===1?'':'s'} late</b></li>`).join('');
  box.innerHTML=`<div class="fly" role="alert"><div class="d-flex align-items-start gap-3"><span class="ic">⚠️</span><div class="flex-grow-1 min-w-0"><div class="fw-bold fs-6">${total} item${total===1?' is':'s are'} overdue</div><ul>${rows}</ul>${total>3?`<div class="small mt-1 opacity-75">and ${total-3} more</div>`:''}<div class="d-flex gap-2 mt-2"><button class="btn btn-sm btn-light fw-semibold" data-a="kpi" data-v="__over">View overdue</button><button class="btn btn-sm btn-outline-light" data-a="fly-close">Later</button></div></div><button class="btn-close btn-close-white" data-a="fly-close" aria-label="Dismiss"></button></div></div>`;
  const el=box.firstElementChild,rest=()=>{clearTimeout(this._flyT);this._flyT=setTimeout(()=>this.hideFly(),12000)};
  rest();el.onmouseenter=()=>clearTimeout(this._flyT);el.onmouseleave=rest},
 hideFly(){const el=document.querySelector('#fly .fly');if(!el)return;clearTimeout(this._flyT);el.classList.add('out');setTimeout(()=>{if(el.parentNode)el.remove()},420)},

 /* An empty message hides the indicator entirely, dot and all. */
 status(t,ok){$('#snap').textContent=t||'';$('#lv').classList.toggle('off',!ok);$('#lv').classList.toggle('d-none',!t)},
 /* one-time behaviours: reveal-on-scroll for .a-up, click ripple on buttons, delegated Bootstrap tooltips */
 init(){
  const root=document.documentElement;
  if('IntersectionObserver' in window){
   const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.05,rootMargin:'0px 0px 40px 0px'});
   const scan=()=>document.querySelectorAll('.a-up:not(.in):not([data-io])').forEach(el=>{el.dataset.io=1;io.observe(el)});
   new MutationObserver(scan).observe(document.body,{childList:true,subtree:true});scan()}
  else root.classList.add('no-io');
  setInterval(()=>document.querySelectorAll('.a-up:not(.in)').forEach(el=>el.classList.add('in')),1200);
  document.addEventListener('pointerdown',e=>{const b=e.target.closest('.btn');if(!b||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
   const r=b.getBoundingClientRect(),d=Math.max(r.width,r.height),s=document.createElement('span');s.className='ripple';
   s.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;b.appendChild(s);setTimeout(()=>s.remove(),650)});
  if(window.bootstrap)new bootstrap.Tooltip(document.body,{selector:'[data-bs-toggle="tooltip"]',trigger:'hover',delay:{show:350,hide:0}})},
 /* theme picker (dropdown in the hero) */
 themes:[],                       /* filled in by the Presenter at start-up */
 /* The person signed in. Drawn, not an emoji, so it is the same shape on every device and sits
    properly in the circle. It takes the text colour, which on the circle is white. */
 ICON_USER:'<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">'
  +'<circle cx="8" cy="5.1" r="2.9"/>'
  +'<path d="M8 9.1c-3.1 0-5.3 1.8-5.3 4 0 .5.4.9.9.9h8.8c.5 0 .9-.4.9-.9 0-2.2-2.2-4-5.3-4Z"/></svg>',

 /* The way out, drawn rather than borrowed from an emoji set: the arrow leaving a box that
    every application uses for this, so it reads as "log out" and not as a door. It follows the
    text colour, so it turns red with the rest of the item. */
 ICON_LOGOUT:'<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor"'
  +' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  +'<path d="M6.5 14H3.6A1.6 1.6 0 0 1 2 12.4V3.6A1.6 1.6 0 0 1 3.6 2h2.9"/>'
  +'<path d="M10.4 11.2 13.6 8l-3.2-3.2"/><path d="M13.6 8H6.2"/></svg>',

 /* The Settings menu: who you are, your own account, the theme and signing out.
    `passwords` is false on the claude.ai build, where there is no password to change. */
 settingsMenu(sess,passwords){
  const box=$('#stm');if(!box)return;
  if(!sess){box.innerHTML='';return}
  const cur=document.documentElement.getAttribute('data-theme')||'light';
  const item=(action,icon,label,extra)=>`<li><button class="dropdown-item d-flex align-items-center gap-2 ${extra||''}" data-a="${action}"><span class="mi">${icon}</span>${label}</button></li>`;
  box.innerHTML=
   `<li class="px-3 pt-2 pb-1"><div class="fw-semibold text-truncate d-flex align-items-center gap-2" style="max-width:220px">`
   +`<span class="av av-sm av-ic" style="background:${ROLE_COL[sess.role]}">${this.ICON_USER}</span>`
   +`<span class="text-truncate">${esc(sess.name)}</span></div>`
   +`<div class="text-secondary small text-truncate" style="max-width:220px">${esc(sess.email)}</div>`
   +`<span class="badge rounded-pill role mt-1" style="--c:${ROLE_COL[sess.role]}">${ROLE_LBL[sess.role]}</span></li>`
   +`<li><hr class="dropdown-divider"></li>`
   +item('profile','👤','My profile')
   +(passwords?item('password','🔑','Update password'):'')
   +(sess.role==='superadmin'?item('users','👥','Users &amp; roles'):'')
   +item('share','🔗','Share link')
   +`<li><hr class="dropdown-divider"></li><li><h6 class="dropdown-header py-1">Theme</h6></li>`
   +(this.themes||[]).map(t=>`<li><button class="dropdown-item d-flex align-items-center gap-2 ${t.id===cur?'active':''}" data-a="theme" data-v="${t.id}"><span class="sw" style="background:${t.swatch}"></span>${t.label}${t.id===cur?'<span class="ms-auto">✓</span>':''}</button></li>`).join('')
   +`<li><hr class="dropdown-divider"></li>`
   +item('signout',this.ICON_LOGOUT,'Logout','text-danger')},
 /* KPI numbers count up from 0 after the overview renders */
 countUp(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  document.querySelectorAll('.kpi b[data-n]').forEach(el=>{const n=+el.dataset.n||0;if(!n)return;const t0=performance.now(),D=700;
   const step=t=>{const k=Math.min(1,(t-t0)/D),e=1-Math.pow(1-k,3);el.textContent=Math.round(n*e);if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step)})},
 nav(tabs,cur,badges){$('#nav').innerHTML=tabs.map(x=>{
  const n=badges&&badges[x[0]];
  return `<li class="nav-item"><button class="nav-link ${x[0]===cur?'active':''}" data-a="go" data-v="${x[0]}">${x[1]}`
   +(n?` <span class="badge rounded-pill unread">${n>99?'99+':n}</span>`:'')+`</button></li>`}).join('')},
 page(html){document.querySelectorAll('.tooltip').forEach(t=>t.remove());
  $('#v').innerHTML=(this.offlineBanner||'')+'<div class="fade-in">'+html+'</div>'},

 /* Shown on every page while no server is connected, because otherwise work is saved into one
    browser and quietly goes nowhere else – which looks exactly like the app being broken. */
 offlineBanner:'',
 setOfflineNotice(show,detail,canRetry){
  this.offlineBanner=show?`<div class="alert offline-note d-flex flex-wrap align-items-center gap-2" role="status">`
   +`<span class="fs-5">📴</span><span><b>This device only.</b> No server is connected, so anything you`
   +` add stays in this browser: it will not reach the Google Sheet, colleagues will not see it, and chat`
   +` cannot run.${detail?' '+esc(detail):''}</span>`
   /* A server that was configured but did not answer is usually just slow, so give the person a
      way back to it instead of leaving them in this browser for the rest of the session. */
   +(canRetry?`<button class="btn btn-sm btn-outline-dark ms-auto" onclick="location.reload()">Try the server again</button>`:'')
   +`</div>`:''},

 /* --- gate screens shown while nobody is signed in --- */
 gate(kind,msg,storeKind,canEmail){
  const fld=(lbl,html)=>`<div class="mb-3"><label class="form-label small fw-semibold text-secondary mb-1">${lbl}</label>${html}</div>`;
  const shell=(ic,title,sub,body,c)=>`<div class="card tcard gate mx-auto my-4 my-md-5 a-up" style="--c:${c}"><div class="card-body p-4"><div class="d-flex align-items-center gap-3 mb-3"><span class="pi" style="--c:${c}">${ic}</span><div><h2 class="h4 fw-bold mb-0">${title}</h2><p class="text-secondary small mb-0">${sub}</p></div></div>${body}</div></div>`;
  let h='';
  if(kind==='loading')h=shell('⏳','Connecting…','Checking who you are','<div class="progress" style="height:6px"><div class="progress-bar progress-bar-striped progress-bar-animated w-100"></div></div>','#4f46e5');
  else if(kind==='setup')h=shell('🛡️','Create the super admin','First run – this account manages all users and roles',
   fld('Your name','<input class="form-control" id="g_name" autocomplete="name">')+fld('Email','<input class="form-control" id="g_email" type="email" autocomplete="username">')+
   '<div class="row g-3">'+fld('Password','<input class="form-control" id="g_pw" type="password" autocomplete="new-password">').replace('mb-3','col-sm-6')+fld('Confirm password','<input class="form-control" id="g_pw2" type="password" autocomplete="new-password">').replace('mb-3','col-sm-6')+'</div>'+
   `<button class="btn btn-brand w-100 mt-3" id="g_btn">Create super admin account</button><p class="text-secondary small mt-3 mb-0">Accounts are kept in this browser${storeKind==='local'?'':' / the shared database'}. The super admin can add Admins, Superusers and Viewers afterwards.</p>`,'#ec008c');
  else if(kind==='login')h=shell('🔐','Sign in','Use the email and password the super admin gave you',
   fld('Email','<input class="form-control" id="g_email" type="email" autocomplete="username">')+fld('Password','<input class="form-control" id="g_pw" type="password" autocomplete="current-password">')+
   '<div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="g_rem" checked><label class="form-check-label small" for="g_rem">Keep me signed in on this device</label></div><button class="btn btn-brand w-100" id="g_btn">Sign in</button>'+
   (canEmail?'<p class="text-center mt-3 mb-0"><a href="#" id="g_forgot" class="small">Forgot your password?</a></p>':'')+
   `<div class="roles mt-4">${ROLES.map(r=>`<div class="d-flex gap-2 align-items-baseline small"><span class="badge rounded-pill b" style="--c:${ROLE_COL[r]}">${ROLE_LBL[r]}</span><span class="text-secondary">${ROLE_DESC[r]}</span></div>`).join('')}</div>`,'#4f46e5');
  else if(kind==='forgot')h=shell('✉️','Forgot your password?','We will email you a six-digit code',
   fld('Your email','<input class="form-control" id="g_email" type="email" autocomplete="username">')+
   '<button class="btn btn-brand w-100" id="g_btn">Email me a code</button>'+
   '<p class="text-center mt-3 mb-0"><a href="#" id="g_back" class="small">Back to sign in</a></p>','#0891b2');
  else if(kind==='reset')h=shell('🔑','Enter the code','Check your email, then choose a new password',
   fld('Email','<input class="form-control" id="g_email" type="email" autocomplete="username" value="'+esc(msg||'')+'">')+
   fld('Six-digit code','<input class="form-control text-center" id="g_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="letter-spacing:.5em;font-size:1.3rem">')+
   '<div class="row g-3">'+fld('New password','<input class="form-control" id="g_pw" type="password" autocomplete="new-password">').replace('mb-3','col-sm-6')+fld('Confirm password','<input class="form-control" id="g_pw2" type="password" autocomplete="new-password">').replace('mb-3','col-sm-6')+'</div>'+
   '<button class="btn btn-brand w-100 mt-3" id="g_btn">Change my password</button>'+
   '<p class="text-center mt-3 mb-0"><a href="#" id="g_again" class="small">Send a new code</a> · <a href="#" id="g_back" class="small">Back to sign in</a></p>','#0891b2');
  else h=shell('🔒','Access restricted','',`<p class="mb-0">${esc(msg)}</p>`,'#dc2626');
  $('#v').innerHTML=h},
 /* --- signed-in person in the hero + which toolbar buttons they get --- */
 who(sess,local){const w=$('#who');
  const box=$('#settings');
  w.classList.toggle('d-none',!sess);if(box)box.classList.toggle('d-none',!sess);
  this.settingsMenu(sess,local);
  /* The sign-in page carries nothing at all – no controls and no status line. */
  if(!sess){w.innerHTML='';this.status('',false);return}
  /* A person, on a circle in their role's colour, with the role spelled out alongside. */
  w.innerHTML=`<span class="av av-sm av-ic" style="background:${ROLE_COL[sess.role]}" title="${esc(ROLE_LBL[sess.role]||'')}">${this.ICON_USER}</span><span class="d-none d-sm-inline-block text-truncate" style="max-width:160px" title="${esc(sess.email)}">${esc(sess.name)}</span><span class="badge rounded-pill role" style="--c:${ROLE_COL[sess.role]}">${ROLE_LBL[sess.role]}</span>`},
 ph:(ic,t,sub,c,act)=>`<div class="ph d-flex align-items-center flex-wrap gap-3" style="--c:${c}"><span class="pi">${ic}</span><div><h2 class="mb-0">${t}</h2><p class="mb-0 text-secondary small">${sub}</p></div><div class="pa ms-auto d-flex flex-wrap gap-2">${act||''}</div></div>`,

 /* Bootstrap modal shell: returns the .modal element; el.close() hides it, it removes itself once hidden */
 modalShell({title,body,foot,c,size}){
  const el=document.createElement('div');el.className='modal fade';el.tabIndex=-1;
  el.innerHTML=`<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable ${size||'modal-lg'}"><div class="modal-content" style="--c:${c||'#4f46e5'}">
   <div class="modal-header"><div class="me-3 flex-grow-1">${title}</div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
   <div class="modal-body">${body}</div>${foot?`<div class="modal-footer justify-content-start gap-2">${foot}</div>`:''}</div></div>`;
  document.body.appendChild(el);const inst=new bootstrap.Modal(el);let shown=false,pending=false;
  el.addEventListener('shown.bs.modal',()=>{shown=true;if(pending)inst.hide()});el.addEventListener('hidden.bs.modal',()=>el.remove());
  el.close=()=>{if(shown)inst.hide();else pending=true};/* a close requested mid-animation is applied once the modal is fully shown */
  inst.show();return el},

 pie(c){const t=PS.reduce((x,k)=>x+(c[k]||0),0);if(!t)return '<svg class="pie-svg" viewBox="0 0 120 120" width="150" height="150"><circle cx="60" cy="60" r="56" fill="var(--bs-border-color)"/></svg>';
  let a=-Math.PI/2,o='';PS.filter(k=>c[k]).forEach(k=>{const f=c[k]/t;if(f>=.9999){o+=`<circle cx="60" cy="60" r="56" fill="${COL[k]}"/>`;return}
   const e=a+f*2*Math.PI,x1=60+56*Math.cos(a),y1=60+56*Math.sin(a),x2=60+56*Math.cos(e),y2=60+56*Math.sin(e);
   o+=`<path d="M60 60L${x1} ${y1}A56 56 0 ${f>.5?1:0} 1 ${x2} ${y2}Z" fill="${COL[k]}" stroke="var(--surface)" stroke-width="1.5"/>`;a=e});
  return `<svg class="pie-svg" viewBox="0 0 120 120" width="150" height="150">${o}</svg>`},
 pieCard(label,arr,key,col){const c={};arr.forEach(p=>c[p.s]=(c[p.s]||0)+1);
  return card(col,sec(col,`${label} · ${arr.length}`)+`<p class="text-secondary small mb-3">${DEF[key]}</p><div class="d-flex align-items-center flex-wrap gap-4">${this.pie(c)}<div>${PS.map(k=>`<div class="leg" style="--c:${COL[k]}" data-a="pf" data-v="${key}|${k}"><i></i>${k} <b>${c[k]||0}</b> <span class="text-secondary small">${arr.length?Math.round((c[k]||0)/arr.length*100):0}%</span></div>`).join('')}</div></div>`)},

 skeleton(){const k=n=>Array.from({length:n},(_,i)=>`<div class="col a-up" style="--i:${i}"><div class="card tcard placeholder-glow" style="--c:var(--bs-border-color)"><div class="card-body"><span class="placeholder col-5 rounded-pill mb-3"></span><span class="placeholder col-12 mb-2"></span><span class="placeholder col-8 mb-2"></span><span class="placeholder col-10"></span></div></div></div>`).join('');
  return this.ph('📊','Dashboard Overview','Loading live data…','#4f46e5')+`<div class="row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-xl-7 g-2 mb-3">${k(7)}</div><div class="row row-cols-1 row-cols-lg-3 g-3">${k(3)}</div>`},
 overview(){
  if(!Model.loaded)return this.skeleton();
  const I=Model.items,c={};I.forEach(p=>c[p.s]=(c[p.s]||0)+1);const od=I.filter(over);
  const K=[['Total',I.length,'','#4f46e5'],...ST.map(s=>[s,c[s]||0,s,COL[s]]),['Overdue',od.length,'__over','#dc2626']];
  const kp=K.map((k,i)=>`<div class="col a-up" style="--i:${i}"><button class="card kpi w-100 text-start" style="--c:${k[3]}" data-a="kpi" data-v="${k[2]}"><span class="ki">${IC[k[0]]}</span><b data-n="${k[1]}">${k[1]}</b><span>${k[0]}</span></button></div>`).join('');
  const W={};I.forEach(p=>{const n=base(p.f1);if(!n)return;W[n]=W[n]||{Ongoing:0,'On Hold':0,Listed:0};if(W[n][p.s]!=null)W[n][p.s]++});
  const rows=Object.entries(W).map(([n,w])=>[n,w,w.Ongoing+w['On Hold']+w.Listed]).filter(r=>r[2]).sort((a,b)=>b[2]-a[2]);
  const mx=Math.max(...rows.map(r=>r[2]),1);
  const wl=rows.map(([n,w,t])=>`<div class="wr"><a href="#" class="fw-semibold text-body text-decoration-none text-truncate" data-a="person" data-v="${esc(n)}">${esc(n)}</a><div class="progress-stacked" style="width:${t/mx*100}%;height:10px">${['Ongoing','On Hold','Listed'].map(s=>`<div class="progress" style="width:${w[s]/t*100}%;height:10px"><div class="progress-bar" style="background:${COL[s]}"></div></div>`).join('')}</div><b>${t}</b></div>`).join('');
  const li=a=>a.map(p=>`<li class="list-group-item list-group-item-action d-flex justify-content-between gap-2 px-0" data-a="open" data-v="${esc(p.id)}"><span><span class="id">${esc(p.id)}</span> ${esc(p.title)}</span><em>${esc(base(p.f1))} · ${fd(p.e)}</em></li>`).join('')||'<li class="list-group-item px-0"><em>None 🎉</em></li>';
  const on=I.filter(p=>p.s==='Ongoing').sort((a,b)=>(a.e||'9')<(b.e||'9')?-1:1);
  const pl=on.slice(0,12).map(p=>{const g=pct(p);return `<li class="list-group-item list-group-item-action px-0" data-a="open" data-v="${esc(p.id)}"><div class="d-flex justify-content-between gap-2"><span><span class="id">${esc(p.id)} · ${LBL[p.type]||p.type}</span> ${esc(p.title)}</span><em>${esc(base(p.f1))}</em></div>${bar(g,'#2563eb',4,true)}<div class="d-flex justify-content-between text-secondary small mt-1"><span>${g==null?'no milestones':g+'% complete'}</span><span class="${over(p)?'od':''}">${p.e?(over(p)?'⚠ ':'')+fd(p.e):''}</span></div></li>`}).join('')||'<li class="list-group-item px-0"><em>No ongoing items</em></li>';
  const oh=I.filter(p=>p.s==='On Hold');
  return this.ph('📊','Dashboard Overview','Live status of every project, recurring item and task','#4f46e5',xbtns('Download or print ALL data – projects, recurring items and tasks'))+`<div class="row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-xl-7 g-2 mb-3">${kp}</div>
  <div class="row g-3 mb-3"><div class="col-12 col-lg-4 a-up" style="--i:1">${this.pieCard('📁 Projects',I.filter(p=>p.type==='Project'),'Project','#4f46e5')}</div><div class="col-12 col-lg-4 a-up" style="--i:2">${this.pieCard('🔁 Recurring',I.filter(p=>p.type==='Drive'),'Drive','#0891b2')}</div><div class="col-12 col-lg-4 a-up" style="--i:3">${this.pieCard('✔️ Tasks',Model.all().filter(p=>p.type==='Task'),'Task','#ea580c')}</div></div>
  <div class="row g-3 mb-3"><div class="col-12 col-lg-6 a-up" style="--i:4">${card('#2563eb',sec('#2563eb',`⚡ Ongoing – progress (${on.length})`)+`<ul class="list-group list-group-flush">${pl}</ul>${on.length>12?`<p class="small mt-2 mb-0"><a href="#" data-a="kpi" data-v="Ongoing">View all ${on.length} →</a></p>`:''}`)}</div>
  <div class="col-12 col-lg-6 a-up" style="--i:5">${card('#7c3aed',sec('#7c3aed','👥 Active workload by Focal-1')+(wl||empty('No active items'))+`<p class="text-secondary small mt-2 mb-0"><span style="color:${COL.Ongoing}">■</span> Ongoing <span style="color:${COL['On Hold']}">■</span> On hold <span style="color:${COL.Listed}">■</span> Listed</p>`)}</div></div>
  <div class="row g-3 mb-3"><div class="col-12 col-lg-6 a-up" style="--i:6">${card('#dc2626',sec('#dc2626',`⚠️ Overdue – ongoing past end date (${od.length})`)+`<ul class="list-group list-group-flush">${li(od.sort((a,b)=>a.e<b.e?-1:1).slice(0,8))}</ul>`)}</div>
  <div class="col-12 col-lg-6 a-up" style="--i:7">${card('#d97706',sec('#d97706',`⏸️ On hold (${oh.length})`)+`<ul class="list-group list-group-flush">${li(oh.slice(0,8))}</ul>`)}</div></div>`},

 filters(items){return `<div class="row g-2 align-items-center my-2">${items.join('')}</div>`},
 board(type,F){
  const pg=PAGES[type],who=[...new Set(Model.items.filter(p=>p.type===type).flatMap(own))].sort();
  return this.ph(pg.ic,LBLS[type],DEF[type],pg.c,xbtns()+(Model.can('write',type)?`<button class="btn btn-brand" data-a="new" data-v="${type}">＋ Create ${LBL[type]}</button>`:''))+this.filters([
   `<div class="col-12 col-md"><input class="form-control" id="q" placeholder="Search title, ID, stakeholder…" value="${esc(F.q)}"></div>`,
   `<div class="col-6 col-md-auto"><select class="form-select" id="fs"><option value="">All status</option>${ST.map(s=>`<option>${s}</option>`).join('')}<option value="__over">Overdue</option></select></div>`,
   `<div class="col-6 col-md-auto"><select class="form-select" id="fp"><option value="">All priorities</option><option>High</option><option>Mid</option><option>Low</option></select></div>`,
   `<div class="col-6 col-md-auto"><select class="form-select" id="fw"><option value="">All people</option>${who.map(w=>`<option>${esc(w)}</option>`).join('')}</select></div>`,
   `<div class="col-6 col-md-auto"><button class="btn btn-outline-secondary w-100" id="rs">Reset</button></div>`])+`<div id="res"></div>`},
 boardResults(F,L){
  return `<p class="text-secondary small">${L.length} item${L.length===1?'':'s'}${F.st?` · Filter: <b>${F.st==='__over'?'Overdue':F.st}</b> <a href="#" data-a="kpi" data-v="">clear</a>`:''}</p><div class="bd">${ST.map(s=>{
   const a=L.filter(p=>F.st==='__over'?s==='Ongoing'&&over(p):p.s===s).sort((x,y)=>s==='Ongoing'?((x.e||'9')<(y.e||'9')?-1:1):((PO[x.pri]!=null?PO[x.pri]:3)-(PO[y.pri]!=null?PO[y.pri]:3)));
   return `<div class="kcol" style="--c:${COL[s]}"><h4 class="d-flex justify-content-between align-items-center">${IC[s]} ${s}<span class="badge rounded-pill" style="background:${COL[s]}">${a.length}</span></h4><div class="cb">${a.map((p,i)=>{const g=pct(p);return `<div class="card it a-up" style="--i:${i}" data-a="open" data-v="${esc(p.id)}"><div class="card-body p-2 px-3"><span class="id">${esc(p.id)} · ${esc(LBL[p.type]||p.type)}</span><div class="t">${esc(p.title)}</div><div class="m d-flex justify-content-between flex-wrap gap-1 text-secondary"><span>${p.pri?`<i class="pr" style="background:${PC[p.pri]}"></i>${p.pri} · `:''}${esc(base(p.f1))}${p.f2?' + '+esc(p.f2):''}</span><span class="${over(p)?'od':''}">${p.type==='Drive'?(p.ud?'↻ '+fd(p.ud):''):(p.e?(over(p)?'⚠ ':'')+fd(p.e):'')}</span></div>${p.type==='Project'?`<div class="m d-flex justify-content-between text-secondary mt-2"><span>📅 ${fd(p.sd)} → ${fd(p.e)}</span><b>${g==null?'no milestones yet':g+'% complete'}</b></div>${bar(g,COL[s],4,s==='Ongoing')}`:(g!=null?bar(g,COL[s],4,s==='Ongoing'):'')}</div></div>`}).join('')||empty('Nothing here')}</div></div>`}).join('')}</div>`},

 tasks(TF){
  const who=[...new Set(Model.all().filter(t=>t.type==='Task').map(t=>t.f1).filter(Boolean))].sort();
  return this.ph('✅','Tasks',DEF.Task,'#ea580c',xbtns()+(Model.can('write','Task')?'<button class="btn btn-brand" data-a="new" data-v="Task">＋ Create Task</button>':''))+this.filters([
   `<div class="col-12 col-md"><input class="form-control" id="tq" placeholder="Search tasks…" value="${esc(TF.q)}"></div>`,
   `<div class="col-6 col-md-auto"><select class="form-select" id="tw"><option value="">All people</option>${who.map(w=>`<option>${esc(w)}</option>`).join('')}</select></div>`,
   `<div class="col-6 col-md-auto"><select class="form-select" id="ts"><option value="">All status</option>${ST.map(s=>`<option>${s}</option>`).join('')}</select></div>`])+`<div id="res"></div>`},
 taskResults(TF,L){
  return `<p class="text-secondary small">${L.length} tasks</p><div class="card tcard" style="--c:#ea580c"><div class="table-responsive"><table class="table table-hover align-middle mb-0"><thead><tr><th>ID</th><th>Task</th><th>Owner</th><th>Priority</th><th>Status</th><th>Start</th><th>End</th></tr></thead><tbody>${L.slice(0,TF.n).map((t,i)=>`<tr class="c a-up" style="--i:${i}" data-a="open" data-v="${esc(t.id)}"><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.f1)}</td><td>${esc(t.pri)}</td><td>${badge(t.s)}</td><td>${fd(t.sd)}</td><td>${fd(t.e)}</td></tr>`).join('')}</tbody></table></div></div>${L.length>TF.n?`<p class="mt-3"><button class="btn btn-outline-secondary" id="mr">Show more</button></p>`:''}`},

 mt(r){return `<table class="table table-sm text-center mt mb-0"><thead><tr><th></th><th style="color:${COL.Ongoing}">Ongoing</th><th style="color:${COL['On Hold']}">On Hold</th><th style="color:${COL.Done}">Done</th></tr></thead><tbody>${TY.map(t=>`<tr><td class="text-start">${LBLS[t]}</td><td><b>${r[t].Ongoing}</b></td><td><b>${r[t]['On Hold']}</b></td><td><b>${r[t].Done}</b></td></tr>`).join('')}</tbody></table>`},
 person(n,size){return `<div class="d-flex gap-3 align-items-center mb-3"><span class="av" style="background:${avc(n)}">${esc(n[0])}</span><b class="${size||'fs-6'}">${esc(n)}</b></div>`},
 team(SEL){
  if(SEL){const r=Model.counts(SEL),A=Model.all().filter(p=>own(p).includes(SEL));
   const grp=s=>{const a=A.filter(p=>p.s===s);if(!a.length)return '';
    return `<details ${['Ongoing','On Hold','Listed'].includes(s)?'open':''}><summary style="color:${COL[s]}">${s} (${a.length})</summary><ul class="list-group list-group-flush">${a.sort((x,y)=>(y.e||'')<(x.e||'')?-1:1).slice(0,s==='Done'?60:200).map(p=>`<li class="list-group-item list-group-item-action d-flex justify-content-between gap-2 px-0" data-a="open" data-v="${esc(p.id)}"><span><span class="badge rounded-pill b" style="--c:#64748b">${LBL[p.type]||p.type}</span> ${esc(p.title)}</span><em>${base(p.f1)===SEL?'Lead':'Support'} · ${fd(p.e)}</em></li>`).join('')}</ul></details>`};
   return this.ph('👤',esc(SEL),'Projects, recurring items and tasks – Ongoing, On Hold and Done','#7c3aed',xbtns()+'<button class="btn btn-outline-secondary" data-a="person" data-v="">← All members</button>')+`<div class="row g-3"><div class="col-12 col-lg-5">${card('#7c3aed',this.person(SEL,'fs-5')+this.mt(r))}</div><div class="col-12 col-lg-7">${card('#7c3aed',ST.map(grp).join('')||empty('No items yet'))}</div></div>`}
  /* Only the super admin may change the roster; everyone else sees the same page without
     the controls. A member who is on the roster shows their designation and email; a name
     that only appears on items is marked unlisted, with a way to add them. */
  const manage=Model.can('manage');
  const tools=n=>{if(!manage)return '';const m=Model.member(n);
   return m?`<div class="d-flex gap-2 mt-2 team-tools"><button class="btn btn-sm btn-outline-secondary" data-a="team-edit" data-v="${esc(n)}">✎ Edit</button><button class="btn btn-sm btn-outline-danger" data-a="team-del" data-v="${esc(n)}">Remove</button></div>`
    :`<div class="d-flex gap-2 mt-2 team-tools"><span class="badge text-bg-light text-secondary align-self-center">unlisted</span><button class="btn btn-sm btn-outline-secondary" data-a="team-add" data-v="${esc(n)}">＋ Add to team</button></div>`};
  const detail=n=>{const m=Model.member(n);if(!m||(!m.title&&!m.email))return '';
   return `<div class="text-secondary small mt-n2 mb-2">${esc(m.title||'')}${m.title&&m.email?' · ':''}${esc(m.email||'')}</div>`};
  return this.ph('👥','Team','Workload of every member – click a card for the full list','#7c3aed',xbtns()+(manage?'<button class="btn btn-brand" data-a="team-add" data-v="">＋ Add member</button>':''))+`<div class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3">${Model.people().map((n,i)=>`<div class="col a-up" style="--i:${i}">${card(avc(n),this.person(n)+detail(n)+this.mt(Model.counts(n))+tools(n),'pc" data-a="person" data-v="'+esc(n))}</div>`).join('')||'<div class="col">'+empty(manage?'No team members yet – add one with the button above.':'No team members yet.')+'</div>'}</div><p class="text-secondary small mt-3">Counts include items where the person is Focal-1 or Focal-2. Click a member for the full list.${manage?' Only the super admin can add, edit or remove members.':''}</p>`},

 /* The member dialog: name, designation, email. Removing is offered here too, with the
    reminder that their items are not touched by it. */
 member(x,isNew){
  const fld=(lbl,html)=>`<div class="mb-3"><label class="form-label small fw-semibold text-secondary mb-1">${lbl}</label>${html}</div>`;
  return this.modalShell({c:'#7c3aed',size:'modal-md',
   title:`<h2 class="h5 fw-bold mb-0">${isNew?'Add team member':'Edit team member'}</h2><div class="text-secondary small">${isNew?'They will appear on the Team page and in the Focal lists':'Renaming can also rename them on their items'}</div>`,
   body:fld('Name *',`<input class="form-control" id="tm_name" value="${esc(x.name||'')}" autocomplete="off">`)
    +fld('Designation',`<input class="form-control" id="tm_title" value="${esc(x.title||'')}" placeholder="e.g. Senior Officer, IS">`)
    +fld('Email',`<input class="form-control" id="tm_email" type="email" value="${esc(x.email||'')}" placeholder="optional">`),
   foot:(isNew?'':'<button class="btn btn-outline-danger me-auto" id="tm_del">Remove from team</button>')+'<button class="btn btn-brand" id="tm_save">Save</button>'})},

 /* --- chat lives in a floating panel, not a page --- */

 /** Show or hide the floating button, following the sign-in state. */
 chatDock(show){
  const dock=$('#chatdock');if(dock)dock.classList.toggle('d-none',!show);
  if(!show)this.chatOpen(false)},

 /** Open or close the popup. The scrim only dims the page on a narrow screen. */
 chatOpen(open){
  const pop=$('#chatpop'),fab=$('#chatfab'),scrim=$('#chatscrim');
  if(!pop||!fab)return;
  if(open){
   pop.hidden=false;scrim.hidden=false;
   /* a frame later, so the browser animates from the closed state rather than jumping */
   requestAnimationFrame(()=>{pop.classList.add('open');scrim.classList.add('open')});
  }else{
   pop.classList.remove('open');scrim.classList.remove('open');
   setTimeout(()=>{if(!pop.classList.contains('open')){pop.hidden=true;scrim.hidden=true}},260);
  }
  pop.setAttribute('aria-hidden',open?'false':'true');
  fab.setAttribute('aria-expanded',open?'true':'false');
  fab.classList.toggle('open',open)},

 chatIsOpen(){const pop=$('#chatpop');return Boolean(pop&&pop.classList.contains('open'))},

 /** Which half of the panel is showing: the colleague list, or one conversation. */
 chatView(mode,person,live){
  const pop=$('#chatpop');if(!pop)return;
  pop.classList.toggle('in-convo',mode==='convo');
  const back=$('#c_back');if(back)back.hidden=mode!=='convo';
  const title=$('#c_head');
  if(title){
   title.innerHTML=mode==='convo'&&person
    ? `<span class="av av-sm" style="background:${avc(person.name)}">${esc((person.name||'?')[0])}</span>
       <span class="chat-pop-who"><b>${esc(person.name)}</b><span id="c_sub">${esc(person.email)}</span></span>`
    : `<b>Chat</b><span>Message a colleague directly</span>`;
  }
  const ready=Boolean(live&&live.available);
  const box=$('#c_msg'),send=$('#c_send');
  if(box){
   const can=ready&&mode==='convo';
   box.disabled=!can;send.disabled=!can;
   box.placeholder=ready?'Write a message…':'Live chat starts when the server is running';
  }},

 /** The banner shown while there is no chat server, and the live badge. */
 chatStatus(live){
  const note=$('#c_note'),badge=$('#c_state');
  const ready=Boolean(live&&live.available),connected=Boolean(live&&live.connected);
  if(badge){
   /* Three honest states: a live socket, working through ordinary requests, or nothing yet.
      The middle one used to read "Syncing", which never changed and so looked like something
      stuck halfway. It is not halfway: chat is on and working, just a few seconds behind. */
   badge.textContent=connected?'● Live':(ready?'● On · a few seconds':'○ Offline');
   badge.classList.toggle('on',ready);
   badge.title=connected?'Messages arrive instantly'
    :(ready?'There is no socket on this backend, so messages arrive within a few seconds'
      :'Chat server not running');
  }
  if(note){
   note.hidden=ready;
   if(!ready)note.innerHTML=`<b>Preview.</b> This is how chat looks. Messages start moving between
     people once the chat server is running.`;
  }},

 /** The number on the floating button. */
 chatBadge(n){
  const badge=$('#c_fabbadge');if(!badge)return;
  badge.hidden=!n;badge.textContent=n>99?'99+':String(n);
  const fab=$('#chatfab');if(fab)fab.classList.toggle('has-unread',Boolean(n))},

 /** The list of colleagues, newest conversation first. */
 chatContacts(contacts,openWith,filter){
  const box=$('#c_list');if(!box)return;
  const needle=String(filter||'').toLowerCase();
  const shown=contacts.filter(c=>!needle||(c.name+' '+c.email).toLowerCase().includes(needle));
  box.innerHTML=shown.length?shown.map(c=>`
   <button class="list-group-item list-group-item-action chat-person ${c.email===openWith?'active':''}" data-a="chat-open" data-v="${esc(c.email)}">
    <span class="av av-sm" style="background:${avc(c.name)}">${esc((c.name||'?')[0])}<i class="dot ${c.online?'on':''}"></i></span>
    <span class="who-text">
     <span class="d-flex justify-content-between align-items-baseline gap-2">
      <b class="text-truncate">${esc(c.name)}</b>
      ${c.lastAt?`<em class="text-secondary">${esc(shortTime(c.lastAt))}</em>`:''}
     </span>
     <span class="text-secondary small text-truncate d-block">${c.lastBody?(c.lastFromMe?'You: ':'')+esc(c.lastBody):ROLE_LBL[c.role]||''}</span>
    </span>
    ${c.unread?`<span class="badge rounded-pill unread">${c.unread>99?'99+':c.unread}</span>`:''}
   </button>`).join(''):empty('Nobody matches that search.')},

 /** The conversation. Mine on the right, theirs on the left. */
 chatMessages(messages,me,person){
  const log=$('#c_log');if(!log)return;
  if(!person){log.innerHTML=`<div class="chat-empty text-secondary">Choose a colleague to start talking.</div>`;return}
  if(!messages.length){log.innerHTML=`<div class="chat-empty text-secondary">No messages yet. Say hello to ${esc(person.name)}.</div>`;return}

  let lastDay='';
  log.innerHTML=messages.map(m=>{
   const mine=m.from===me.email;
   const day=String(m.at).slice(0,10);
   const divider=day!==lastDay?`<div class="chat-day"><span>${fd(day)}</span></div>`:'';
   lastDay=day;
   return divider+`<div class="chat-row ${mine?'mine':''}">
     <div class="bubble">${esc(m.body).replace(/\n/g,'<br>')}
      <span class="meta">${esc(shortTime(m.at))}${mine?` <span class="tick ${m.readAt?'read':''}">${m.readAt?'✓✓':'✓'}</span>`:''}</span>
     </div></div>`}).join('');
  log.scrollTop=log.scrollHeight},

 /** A short illustrative exchange, so the layout can be seen before anyone has written anything. */
 chatPreviewMessages(person,me){
  const log=$('#c_log');if(!log)return;
  if(!person){log.innerHTML=`<div class="chat-empty text-secondary">Choose a colleague to see the conversation.</div>`;return}
  const clock=mins=>{const d=new Date(Date.now()-mins*60000);return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})};
  const sample=[
   {mine:false,text:`Morning. Any update on the DR site?`,at:clock(42)},
   {mine:true, text:`Hardware arrives Thursday. I will move it to 60% once it is racked.`,at:clock(38),read:true},
   {mine:false,text:`Good. I will tell Operations.`,at:clock(35)},
  ];
  log.innerHTML=`<div class="chat-day"><span>Example conversation</span></div>`
   +sample.map(m=>`<div class="chat-row ${m.mine?'mine':''}"><div class="bubble">${esc(m.text)}
     <span class="meta">${m.at}${m.mine?` <span class="tick ${m.read?'read':''}">${m.read?'✓✓':'✓'}</span>`:''}</span>
    </div></div>`).join('')
   +`<div class="chat-day"><span>Nothing real yet – this is a preview</span></div>`;
  log.scrollTop=log.scrollHeight},

 /** Just the line under the name: typing, online, or their address. */
 chatHeader(person,online,typing){
  const sub=$('#c_sub');if(!sub||!person)return;
  sub.textContent=typing?'typing…':(online?'online':person.email);
  sub.classList.toggle('typing',Boolean(typing))},

 /* --- modals (return the element; Presenter wires the buttons) --- */
 detail(x,w){
  const ms=splitMs(x.ms);
  const rows=[['Owner (Focal-1)',x.f1],['Focal-2',x.f2],['Priority',x.pri],['Start',fd(x.sd)],x.type==='Drive'?['Updated',fd(x.ud)]:['End',fd(x.e)],['Stakeholder',x.sh],['Completion',x.type==='Project'&&pct(x)!=null?pct(x)+'%':''],['Remarks',x.rm]].filter(r=>r[1]&&r[1]!=='—');
  return this.modalShell({c:COL[x.s],
   title:`<span class="id">${esc(x.id)} · ${esc(LBL[x.type]||x.type)}${x.arch?' · archive':''}</span><div class="text-secondary small">${esc(DEF[x.type]||'')}</div><h2 class="h5 fw-bold mt-1 mb-2">${esc(x.title)}</h2>${badge(x.s)} ${over(x)?'<span class="od small">⚠ Overdue</span>':''}`,
   body:`<dl class="row mb-0 small">${rows.map(r=>`<dt class="col-4 col-sm-3 text-secondary fw-normal">${r[0]}</dt><dd class="col-8 col-sm-9">${esc(r[1])}</dd>`).join('')}</dl>
   ${ms.length?`<b class="small">Milestones / progress</b><ul class="small mt-1 mb-0">${ms.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`:''}
   ${w?`<p class="text-secondary small mt-3 mb-2">Change status</p><div class="seg btn-group flex-wrap w-100">${ST.map(s=>`<button type="button" class="btn ${x.s===s?'on':''}" style="--c:${COL[s]}" data-s="${s}">${s==='Done'?'✔ Done':s}</button>`).join('')}</div>`:''}`,
   foot:w?`<button class="btn btn-outline-secondary" id="ed">✎ Edit / add progress</button><button class="btn btn-outline-danger" id="dl">Delete</button>`:''})},
 form(x,AL,edit){
  const fld=(lbl,html,cls='col-sm-6')=>`<div class="${cls}"><label class="form-label small fw-semibold text-secondary mb-1">${lbl}</label>${html}</div>`;
  return this.modalShell({
   title:`<h2 class="h5 fw-bold mb-0">${edit?'Edit':'Create new'} ${LBL[x.type]||x.type}</h2>`,
   body:`<div class="row g-3">
   ${fld('Type',`<div class="seg btn-group w-100" id="ty">${AL.map(t=>`<button type="button" class="btn ${x.type===t?'on':''}" data-t="${t}">${LBL[t]||t}</button>`).join('')}</div><div class="form-text" id="td">${DEF[x.type]}</div>`,'col-12')}
   ${fld('Name / Title *',`<input class="form-control" id="f_t" value="${esc(x.title)}">`,'col-12')}
   ${fld('Start date',`<input type="date" class="form-control" id="f_sd" value="${x.sd||''}">`)}${x.type==='Drive'
    /* a recurring item has no end: it has the date it was last brought up to date */
    ?fld('Update date',`<input type="date" class="form-control" id="f_ud" value="${x.ud||today10()}">`)
    :fld('End date',`<input type="date" class="form-control" id="f_e" value="${x.e||''}">`)}
   ${fld('Focal-1 (lead) *',`<input class="form-control" id="f_1" list="pl" value="${esc(x.f1)}">`)}${fld('Focal-2',`<input class="form-control" id="f_2" list="pl" value="${esc(x.f2)}">`)}
   <datalist id="pl">${Model.people().map(p=>`<option value="${esc(p)}">`).join('')}</datalist>
   ${fld('Priority',`<select class="form-select" id="f_p"><option>High</option><option>Mid</option><option>Low</option></select>`)}${fld('Stakeholder',`<input class="form-control" id="f_h" value="${esc(x.sh)}">`)}
   ${fld('Milestone &amp; progress (one per line)',`<textarea class="form-control" id="f_m" rows="5" placeholder="Requirement analysis - Done&#10;Vendor selection - Ongoing">${esc(splitMs(x.ms).join('\n'))}</textarea>`,'col-12')}</div>`,
   foot:`<button class="btn btn-brand" id="sb">${edit?'Save changes':'Submit → goes to Ongoing'}</button><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>`})},
 share(url){
  return this.modalShell({c:'#ec008c',size:'',title:'<h2 class="h5 fw-bold mb-0">🔗 Share this tracker</h2>',
   body:`<label class="form-label small text-secondary mb-1">Page link</label><div class="input-group"><input class="form-control" id="sl" readonly value="${url}"><button class="btn btn-brand" id="cp">Copy link</button></div>
   <p class="text-secondary small mt-2 mb-0">Only people the super admin has added as users can open the data.</p>`})},
 /* --- your own profile --- */
 profile(sess,canRename){
  return this.modalShell({c:ROLE_COL[sess.role],size:'',
   title:'<h2 class="h5 fw-bold mb-0">👤 My profile</h2>',
   body:`<div class="d-flex gap-3 align-items-center mb-3"><span class="av" style="background:${avc(sess.name)}">${esc(sess.name[0]||'?')}</span>`
    +`<div><div class="fw-semibold">${esc(sess.name)}</div><div class="text-secondary small">${esc(sess.email)}</div></div></div>`
    +`<label class="form-label small fw-semibold text-secondary mb-1">Display name</label>`
    +`<input class="form-control" id="p_name" value="${esc(sess.name)}" ${canRename?'':'disabled'}>`
    +`<p class="text-secondary small mt-2 mb-3">This is the name colleagues see beside your sign-in.</p>`
    +`<label class="form-label small fw-semibold text-secondary mb-1">Email</label>`
    +`<input class="form-control" value="${esc(sess.email)}" disabled>`
    +`<p class="text-secondary small mt-2 mb-0">Your email and role can only be changed by the super admin.`
    +` Your role is <b>${ROLE_LBL[sess.role]}</b> – ${ROLE_DESC[sess.role].toLowerCase()}.</p>`,
   foot:canRename?'<button class="btn btn-brand" id="p_save">Save name</button><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button>':''})},

 /* --- change your own password --- */
 password(){
  const fld=(lbl,id,hint)=>`<div class="mb-3"><label class="form-label small fw-semibold text-secondary mb-1">${lbl}</label>`
   +`<input class="form-control" id="${id}" type="password" autocomplete="${id==='w_cur'?'current-password':'new-password'}">`
   +(hint?`<div class="form-text">${hint}</div>`:'')+`</div>`;
  return this.modalShell({c:'#0891b2',size:'',
   title:'<h2 class="h5 fw-bold mb-0">🔑 Update password</h2>',
   body:fld('Current password','w_cur')+fld('New password','w_new','At least 4 characters.')+fld('Confirm new password','w_new2')
    +'<p class="text-secondary small mb-0">Changing it signs you out of your other devices.</p>',
   foot:'<button class="btn btn-brand" id="w_save">Change password</button><button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>'})},

 /* --- user management modal (super admin) --- */
 users(local){return this.modalShell({c:'#ec008c',title:'<h2 class="h5 fw-bold mb-0">👥 Users &amp; roles</h2><div class="text-secondary small">Only the super admin can add people and assign roles</div>',body:'<div id="ub"></div>'})},
 usersFile(list){const keep=['email','name','role','pw','at','by','id'];const rows=list.map(u=>JSON.stringify(Object.fromEntries(keep.filter(k=>u[k]!=null).map(k=>[k,u[k]]))));
  return `/* Seed accounts – loaded by every device that opens this site, so the sign-in page always has users.\n   Generated ${new Date().toISOString().slice(0,16).replace('T',' ')} from the Users dialog. Replace config/users.js in the repository with this file to publish. */\nwindow.SEED_USERS=[\n ${rows.join(',\n ')}\n];\n`},
 /* `local` here means "accounts have passwords" (browser-only mode or the Node.js backend);
    `showDownload` is only for the static build, where accounts ship in config/users.js. */
 usersPanel(box,list,pend,me,local,showDownload){
  if(showDownload===undefined)showDownload=local;
  const opt=(cur,id)=>`<select class="form-select form-select-sm" ${id}>${ROLES.map(r=>`<option value="${r}" ${r===cur?'selected':''}>${ROLE_LBL[r]}</option>`).join('')}</select>`;
  const tbl=rows=>`<div class="table-responsive"><table class="table table-sm align-middle mb-0">${rows}</table></div>`;
  box.innerHTML=`<div class="roles mb-3">${ROLES.map(r=>`<div class="d-flex gap-2 align-items-baseline small"><span class="badge rounded-pill b" style="--c:${ROLE_COL[r]}">${ROLE_LBL[r]}</span><span class="text-secondary">${ROLE_DESC[r]}</span></div>`).join('')}</div>
  <p class="fw-semibold mb-1">Add a user</p>
  <div class="row g-2 align-items-end mb-3">
   <div class="col-12 col-sm-6 col-lg-3"><label class="form-label small text-secondary mb-1">Name</label><input class="form-control form-control-sm" id="u_name"></div>
   <div class="col-12 col-sm-6 col-lg-3"><label class="form-label small text-secondary mb-1">Email</label><input class="form-control form-control-sm" id="u_email" type="email"></div>
   <div class="col-6 col-sm-6 col-lg-2"><label class="form-label small text-secondary mb-1">Role</label>${opt('viewer','id="u_role"')}</div>
   ${local?'<div class="col-6 col-sm-6 col-lg-2"><label class="form-label small text-secondary mb-1">Password</label><input class="form-control form-control-sm" id="u_pw" type="text" autocomplete="off"></div>':''}
   <div class="col-12 col-lg-2"><button class="btn btn-brand btn-sm w-100" id="u_add">＋ Add user</button></div></div>
  <p class="text-secondary small">${local?'The person signs in with the email and password you set here. You can reset a password at any time.':'The person opens this page with the claude.ai account that has this email; their role is applied automatically.'}</p>
  ${showDownload?'<div class="alert alert-light border small py-2 px-3 d-flex flex-wrap align-items-center gap-2 mb-3"><button class="btn btn-outline-secondary btn-sm" id="u_dl">⬇ Download users.js</button><span>Accounts added here exist only in this browser until you put the downloaded file at <code>config/users.js</code> in the repository. Then every device gets the same sign-in list.</span></div>':''}
  ${pend.length?`<p class="fw-semibold mb-1 mt-3">Waiting for access (${pend.length})</p>${tbl(pend.map(r=>`<tr><td>${esc(r.name||'Unknown')}<br><span class="text-secondary small">${fd(r.at)}</span></td><td><input class="form-control form-control-sm" data-pe="${esc(r.id)}" value="${esc(r.email||'')}" placeholder="email"></td><td style="width:130px">${opt('viewer','data-pr="'+esc(r.id)+'"')}</td><td class="text-end text-nowrap"><button class="btn btn-brand btn-sm" data-ap="${esc(r.id)}">Approve</button> <button class="btn btn-outline-danger btn-sm" data-rj="${esc(r.id)}">✕</button></td></tr>`).join(''))}`:''}
  <p class="fw-semibold mb-1 mt-3">Users (${list.length})</p>
  ${tbl(`<thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>${list.map(u=>{const self=me&&u.email===me.email;return `<tr><td class="fw-semibold">${esc(u.name)}${self?' <span class="text-secondary small">(you)</span>':''}${u.owner||u.by==='owner'?' <span class="text-secondary small">· owner</span>':''}</td><td class="text-secondary">${esc(u.email)}</td><td style="width:140px">${self?`<span class="badge rounded-pill b" style="--c:${ROLE_COL[u.role]}">${ROLE_LBL[u.role]}</span>`:opt(u.role,'data-r="'+esc(u.email)+'"')}</td><td class="text-end text-nowrap">${local?`<button class="btn btn-outline-secondary btn-sm" data-pw="${esc(u.email)}" title="Reset password">🔑</button> `:''}${self?'':`<button class="btn btn-outline-danger btn-sm" data-x="${esc(u.email)}" title="Remove">✕</button>`}</td></tr>`}).join('')}</tbody>`)}`},
};
