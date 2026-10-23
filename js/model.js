/* model.js – data, business rules, roles and storage adapters (cloud / local)
   Part of the MVP split: js/model.js · js/view.js · js/export.js · js/presenter.js (loaded in that order) */

/* ============================== MODEL ============================== */
const ST=['Ongoing','On Hold','Listed','Closed','Done'];
const PS=['Ongoing','Done','On Hold','Listed','Closed'];
const COL={Ongoing:'#2563eb','On Hold':'#d97706',Listed:'#7c3aed',Closed:'#64748b',Done:'#16a34a'};
const PC={High:'#dc2626',Mid:'#d97706',Low:'#16a34a'};
const PO={High:0,Mid:1,Low:2};
const TY=['Project','Drive','Task'],PF={Project:'P',Drive:'D',Task:'T'};
const DEF={Project:'has a timeline and completion %',Drive:'continuous – every cycle',Task:'one-off – happens once, then done'};
const LBL={Project:'Project',Drive:'Recurring',Task:'Task'},LBLS={Project:'Projects',Drive:'Recurring',Task:'Tasks'};
const PAGES={Project:{tab:'projects',ic:'📁',c:'#2563eb'},Drive:{tab:'recurring',ic:'🔁',c:'#0891b2'}};
const IC={Total:'📊',Ongoing:'⚡','On Hold':'⏸️',Listed:'📝',Closed:'🔒',Done:'✅',Overdue:'⚠️'};
const SHARE_URL='https://sajalkumar-byte.github.io/Infrastructure-and-Support-Technology-Task-Tracker/';

/* ---- roles ----
   superadmin : everything + creates users and assigns roles (the only role that can)
   admin      : create / edit / delete / export everything
   superuser  : view everything; create / edit / delete TASKS only; export (PDF, Excel, print)
   viewer     : view only                                                                */
const ROLES=['superadmin','admin','superuser','viewer'];
const ROLE_LBL={superadmin:'Super admin',admin:'Admin',superuser:'Superuser',viewer:'Viewer'};
const ROLE_DESC={superadmin:'Full access, plus user and role management',admin:'Create, edit, delete and export everything',superuser:'View everything · create and edit Tasks · export',viewer:'View only'};
const ROLE_COL={superadmin:'#ec008c',admin:'#4f46e5',superuser:'#0891b2',viewer:'#64748b'};

/* SHA-256 in plain JavaScript – used where crypto.subtle is unavailable (http:// pages, older browsers),
   so the same password always gives the same hash on every device */
function sha256Hex(str){const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 const b=unescape(encodeURIComponent(str)),L=b.length,W=[];for(let i=0;i<L;i++)W[i>>2]|=b.charCodeAt(i)<<(24-(i%4)*8);W[L>>2]|=0x80<<(24-(L%4)*8);W[((L+8>>6)<<4)+15]=L*8;
 let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];const w=new Array(64);const rr=(x,n)=>(x>>>n)|(x<<(32-n));
 for(let j=0;j<W.length;j+=16){let[a,bb,c,d,e,f,g,h]=H;
  for(let i=0;i<64;i++){if(i<16)w[i]=W[j+i]|0;else{const s0=rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3),s1=rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)|0}
   const S1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+K[i]+w[i])|0,S0=rr(a,2)^rr(a,13)^rr(a,22),mj=(a&bb)^(a&c)^(bb&c),t2=(S0+mj)|0;h=g;g=f;f=e;e=(d+t1)|0;d=c;c=bb;bb=a;a=(t1+t2)|0}
  H=[H[0]+a|0,H[1]+bb|0,H[2]+c|0,H[3]+d|0,H[4]+e|0,H[5]+f|0,H[6]+g|0,H[7]+h|0]}
 return H.map(x=>('00000000'+(x>>>0).toString(16)).slice(-8)).join('')}
/* small polyfills so 2018-era phone browsers can run the page */
if(!Array.prototype.flatMap)Array.prototype.flatMap=function(f){return [].concat.apply([],this.map(f))};
if(!Object.fromEntries)Object.fromEntries=function(it){const o={};for(const [k,v] of it)o[k]=v;return o};

const today=new Date();today.setHours(0,0,0,0);
const today10=()=>new Date().toISOString().slice(0,10);
const splitMs=s=>String(s||'').split(/\s*(?:\n|\*|•)\s*/).filter(Boolean);

/* ---- Storage adapters: same interface, two backends ---- */
/* CloudStore: claude.ai shared database (live for everyone with access) */
class CloudStore{
 constructor(db){this.db=db;this.kind='cloud'}
 watch(c,cb,err){return this.db.collection(c).onSnapshot(s=>cb(s.docs.map(d=>d.data())),err||(()=>{}))}
 set(c,id,o){return this.db.doc(c+'/'+id).set(o)}
 update(c,id,o){return this.db.doc(c+'/'+id).update(o)}
 remove(c,id){return this.db.doc(c+'/'+id).delete()}
}
/* LocalStore: browser storage fallback – works when the page is opened outside claude.ai */
class LocalStore{
 constructor(){this.kind='local';this.key='tracker.data.v1';this.subs={};this.data=this._load();this._seed();
  window.addEventListener('storage',e=>{if(e.key===this.key){this.data=this._load();Object.keys(this.subs).forEach(c=>this._emit(c))}})}
 _load(){try{let raw=localStorage.getItem(this.key);if(!raw){raw=localStorage.getItem('mftech.tracker.v1');if(raw)localStorage.setItem(this.key,raw)}return JSON.parse(raw)||{}}catch(e){return{}}}
 _save(){try{localStorage.setItem(this.key,JSON.stringify(this.data))}catch(e){}}
 /* accounts from config/users.js exist on every device; a local record with the same email wins, and a seed user removed here stays removed here */
 _seed(){const seed=window.SEED_USERS||[];if(!seed.length)return;const u=this.data.users=this.data.users||{},gone=this.data.gone||{};let n=0;
  seed.forEach(x=>{if(!x||!x.email)return;const e=String(x.email).trim().toLowerCase(),id=e.replace(/[^a-z0-9]+/g,'_');if(!u[id]&&!gone[id]){u[id]={...x,email:e};n++}});if(n)this._save()}
 _coll(c){return this.data[c]=this.data[c]||{}}
 _emit(c){(this.subs[c]||[]).forEach(f=>f(Object.values(this._coll(c))))}
 watch(c,cb){(this.subs[c]=this.subs[c]||[]).push(cb);cb(Object.values(this._coll(c)));return()=>{}}
 async set(c,id,o){this._coll(c)[id]=o;if(c==='users'&&this.data.gone)delete this.data.gone[id];this._save();this._emit(c)}
 async update(c,id,o){const d=this._coll(c)[id];if(!d)throw new Error('not-found');Object.assign(d,o);this._save();this._emit(c)}
 async remove(c,id){delete this._coll(c)[id];if(c==='users'){(this.data.gone=this.data.gone||{})[id]=true}this._save();this._emit(c)}
}

const Model={
 store:null,user:null,
 items:[],hist:[],
 users:[],reqs:[],
 team:[],           /* the roster the super admin keeps: {id,name,title,email,at,by} */
 session:null,      /* {email,name,role,id?,owner?} – who is signed in */
 platWrite:true,    /* false when the claude.ai platform forbids shared-data writes for this viewer */
 listeners:[],
 onChange(f){this.listeners.push(f)},
 notify(){this.listeners.forEach(f=>f())},

 /* --- queries / rules --- */
 all(){return this.items.concat(this.hist)},
 byId(id){return this.all().find(i=>i.id===id)},
 base:n=>String(n||'').replace(/\s*\(.*?\)/g,'').trim(),
 own(p){return[this.base(p.f1),this.base(p.f2)].filter(Boolean)},
 over:p=>p.s==='Ongoing'&&p.e&&new Date(p.e+'T00:00:00')<today,
 pct(p){const l=splitMs(p.ms);if(p.s==='Done')return 100;if(l.length<2)return null;return Math.round(l.filter(x=>/done|complete/i.test(x)).length/l.length*100)},
 /* Everyone: the roster the super admin keeps, plus anybody named on an item who is not on
    it yet, so nobody disappears from the Team page for not having been added. */
 people(){return[...new Set(this.team.map(m=>m.name).concat(this.all().map(p=>this.base(p.f1))).filter(Boolean))].sort()},
 member(name){const n=String(name||'').trim().toLowerCase();return this.team.find(m=>String(m.name).trim().toLowerCase()===n)||null},
 memberId(name){return 'm_'+(String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_')||Date.now())},
 watchTeam(cb){this.store.watch('team',rows=>{this.team=(rows||[]).filter(m=>m&&m.name);cb()},()=>cb())},
 async saveMember(m){await this.store.set('team',m.id,m)},
 async removeMember(id){await this.store.remove('team',id)},
 /* Rename a person wherever they are Focal-1 or Focal-2. A store that can do it in one go
    does; otherwise each item is updated in turn. Returns how many items changed. */
 async renamePerson(from,to){
  if(this.store.renamePerson)return this.store.renamePerson(from,to);
  const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();
  let n=0;for(const p of this.items){const patch={};
   if(same(this.base(p.f1),from))patch.f1=to;if(same(this.base(p.f2),from))patch.f2=to;
   if(Object.keys(patch).length){await this.store.update('items',p.id,patch);n++}}
  return n},
 counts(n){const r={};TY.forEach(t=>r[t]={Ongoing:0,'On Hold':0,Done:0,Listed:0,Closed:0});
  this.all().forEach(p=>{if(this.own(p).includes(n)&&r[p.type])r[p.type][p.s]++});return r},
 nextId(type){const pf=PF[type]+'-';const n=Math.max(0,...this.all().map(p=>String(p.id||'').startsWith(pf)?+String(p.id).slice(pf.length)||0:0))+1;return pf+n},

 /* --- permissions (the single place that defines what each role may do) --- */
 role(){return this.session?this.session.role:''},
 can(action,type){const r=this.role();if(!r||!this.store)return false;
  switch(action){
   case 'view':return true;
   case 'manage':return r==='superadmin';
   case 'export':return r!=='viewer';
   case 'write':return this.platWrite&&(r==='superadmin'||r==='admin'||(r==='superuser'&&type==='Task'));
   default:return false}},

 /* --- users --- */
 uid:e=>String(e||'').trim().toLowerCase(),
 docId(e){return this.uid(e).replace(/[^a-z0-9]+/g,'_')||'x'},
 findUser(email){const u=this.uid(email);return this.users.find(x=>x.email===u)||null},
 findUserById(id){return id?this.users.find(x=>x.id===id)||null:null},
 async saveUser(u){u.email=this.uid(u.email);await this.store.set('users',this.docId(u.email),u)},
 async updateUser(email,patch){await this.store.update('users',this.docId(email),patch)},
 async removeUser(email){await this.store.remove('users',this.docId(email))},
 async hash(s){const t='tracker:'+s;
  try{if(window.crypto&&crypto.subtle&&window.TextEncoder){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));return[...new Uint8Array(b)].map(x=>('0'+x.toString(16)).slice(-2)).join('')}}catch(e){}
  return sha256Hex(t)},
 watchUsers(cb){this.store.watch('users',rows=>{this.users=rows.filter(u=>u&&u.email);cb()},()=>cb())},
 watchReqs(cb){this.store.watch('requests',rows=>{this.reqs=rows.filter(r=>r&&r.id);cb()},()=>{})},

 /* --- item commands --- */
 /* `fresh` says this is a new item. A server that gives out its own ids must know, or a
    guessed id that happens to exist already would turn a create into an overwrite. */
 async save(o,fresh){await this.store.set('items',o.id,o,{fresh:!!fresh})},
 async setStatus(id,s){await this.store.update('items',id,{s})},
 async remove(id){await this.store.remove('items',id)},

 /* --- data subscription --- */
 started:false,loaded:false,
 start(onStatus){if(this.started)return;this.started=true;
  this.store.watch('items',rows=>{this.items=rows;this.loaded=true;onStatus();this.notify()},e=>onStatus(e));
  this.store.watch('taskhist',rows=>{this.hist=rows.flatMap(d=>(d.rows||[]).map(r=>({...r,arch:true})));this.notify()})}
};
