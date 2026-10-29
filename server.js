'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { PeerServer } = require('peer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/var/data';
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'accounts.json');
const MAX_ACCOUNTS = Math.max(1, Math.min(5000, Number(process.env.MAX_ACCOUNTS || 500)));
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
function emptyStore(){ return { version:1, users:[], sessions:[], transactions:[] }; }
function loadStore(){
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.transactions)) throw new Error('Formato inválido');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') { const initial=emptyStore(); fs.writeFileSync(DATA_FILE, JSON.stringify(initial), {mode:0o600}); return initial; }
    throw new Error(`Não foi possível ler o arquivo persistente ${DATA_FILE}: ${e.message}`);
  }
}
let store = loadStore();
let writeChain = Promise.resolve();
function persistStore(){
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store), {mode:0o600});
  fs.renameSync(temp, DATA_FILE);
}
function persist(){
  // Single Node process: synchronous atomic replacement prevents partially-written JSON.
  persistStore();
}
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const publicUser = u => ({ id:u.id, username:u.username, points:u.points, credits:u.credits, wins:u.wins, inventory:Array.isArray(u.inventory)?u.inventory:[], createdAt:u.created_at });
function getUserByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = store.sessions.find(s => s.token_hash === tokenHash(token) && s.expires_at > Date.now());
  if (!session) return null;
  return store.users.find(u => u.id === session.user_id) || null;
}
function issueToken(userId) {
  const token=crypto.randomBytes(32).toString('base64url');
  store.sessions = store.sessions.filter(s => s.expires_at > Date.now());
  store.sessions.push({token_hash:tokenHash(token),user_id:userId,expires_at:Date.now()+1000*60*60*24*30,created_at:new Date().toISOString()});
  persist();
  return token;
}
function findUserByNameKey(key){ return store.users.find(u=>u.username_key===key) || null; }
function addUser(user){ if(store.users.length>=MAX_ACCOUNTS) return false; if(findUserByNameKey(user.username_key)) return false; store.users.push(user); store.transactions.push({id:crypto.randomUUID(),user_id:user.id,kind:'welcome',amount:1000,note:'Saldo inicial',created_at:new Date().toISOString()}); persist(); return true; }
function updateUser(id, patch){ const u=store.users.find(x=>x.id===id); if(!u)return null; Object.assign(u,patch,{updated_at:new Date().toISOString()}); persist(); return u; }
function json(res,status,data) { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':process.env.SITE_ORIGIN || '*','access-control-allow-headers':'content-type,authorization','access-control-allow-methods':'GET,POST,OPTIONS'});res.end(JSON.stringify(data));}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_MESSAGE_BYTES = 8 * 1024;
const clients = new Map();            // ws -> session
const nicknames = new Map();          // normalized nick -> ws
const rooms = new Map();              // room code -> host metadata (memory only)
const queue = [];                     // temporary matchmaking queue (memory only)

function normalizeNick(value) {
  return String(value || '').normalize('NFC').trim().replace(/[<>]/g, '').replace(/\s+/g, ' ').slice(0, 18);
}
function nickKey(value) { return normalizeNick(value).toLocaleLowerCase('pt-BR'); }
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function onlinePlayers() {
  return [...clients.values()].filter(s => s.authenticated).map(s => ({ name: s.name, points: Number(s.points) || 0, wins: Number(s.wins) || 0, credits: Number(s.credits) || 100 })).sort((a,b) => b.points-a.points || b.wins-a.wins).slice(0,50);
}
function broadcastPresence() {
  const onlineCount = nicknames.size;
  const players = onlinePlayers();
  for (const [ws, session] of clients) {
    if (session.authenticated) send(ws, { type: 'presence', onlineCount, players });
  }
}
function removeFromQueue(ws) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].ws === ws) queue.splice(i, 1);
}
function removeClient(ws) {
  const session = clients.get(ws);
  if (!session) return;
  removeFromQueue(ws);
  if (session.authenticated) {
    const key = nickKey(session.name);
    if (nicknames.get(key) === ws) nicknames.delete(key);
  }
  for (const [code, room] of rooms) if (room.ws === ws) rooms.delete(code);
  clients.delete(ws);
  broadcastPresence();
}
function tryMatch() {
  // Match only players with the same virtual table value. No persistent records.
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    if (!a.ws || a.ws.readyState !== WebSocket.OPEN || !clients.get(a.ws)?.authenticated) {
      queue.splice(i--, 1); continue;
    }
    const j = queue.findIndex((b, idx) => idx > i && b.ws !== a.ws && b.stake === a.stake && b.ws.readyState === WebSocket.OPEN && clients.get(b.ws)?.authenticated);
    if (j < 0) continue;
    const b = queue[j];
    queue.splice(j, 1); queue.splice(i, 1); i--;
    // First in queue hosts; the other player connects to its PeerJS id.
    send(a.ws, { type: 'match-found', role: 'host', peerId: a.peerId, roomCode: a.peerId, stake: a.stake });
    send(b.ws, { type: 'match-found', role: 'guest', peerId: a.peerId, roomCode: a.peerId, stake: b.stake });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { json(res,204,{}); return; }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/' || url.pathname === '/health') {
    json(res,200,{service:'pixzin-vegas',status:'ok',storage:'json-file',accounts:store.users.length,accountLimit:MAX_ACCOUNTS,online:nicknames.size,waiting:queue.length}); return;
  }
  if (url.pathname.startsWith('/api/')) {
    let body='';
    req.on('data',chunk=>{body+=chunk;if(body.length>16*1024){json(res,413,{error:'Requisição muito grande.'});req.destroy();}});
    req.on('end',()=>{
      let data={};try{data=body?JSON.parse(body):{}}catch{json(res,400,{error:'JSON inválido.'});return;}
      const username=String(data.username||'').normalize('NFC').trim().replace(/\s+/g,' ').slice(0,18);
      const key=username.toLocaleLowerCase('pt-BR');
      if(req.method==='POST' && url.pathname==='/api/register'){
        if(username.length<3 || !/^[\p{L}\p{N}_ -]+$/u.test(username)){json(res,400,{error:'Use de 3 a 18 caracteres: letras, números, espaço, hífen ou sublinhado.'});return;}
        if(typeof data.password!=='string' || data.password.length<10 || data.password.length>128){json(res,400,{error:'A senha deve ter de 10 a 128 caracteres.'});return;}
        if(findUserByNameKey(key)){json(res,409,{error:'Esse nome de usuário já existe. Faça login ou escolha outro.'});return;}
        if(store.users.length>=MAX_ACCOUNTS){json(res,507,{error:`O limite de ${MAX_ACCOUNTS} contas foi atingido.`});return;}
        const id=crypto.randomUUID(), hash=bcrypt.hashSync(data.password,12), now=new Date().toISOString();
        const user={id,username,username_key:key,password_hash:hash,points:0,credits:1000,wins:0,inventory:[],created_at:now,updated_at:now};
        try { if(!addUser(user)){json(res,409,{error:'Não foi possível criar a conta. Tente outro nome.'});return;} }
        catch(e){json(res,500,{error:'Não foi possível salvar a conta. Verifique o disco persistente do servidor.'});return;}
        json(res,201,{token:issueToken(id),user:publicUser(user)});return;
      }
      if(req.method==='POST' && url.pathname==='/api/login'){
        const user=findUserByNameKey(key);
        if(!user || typeof data.password!=='string' || !bcrypt.compareSync(data.password,user.password_hash)){json(res,401,{error:'Usuário ou senha incorretos.'});return;}
        json(res,200,{token:issueToken(user.id),user:publicUser(user)});return;
      }
      const auth=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
      const user=getUserByToken(auth);
      if(url.pathname==='/api/me' && req.method==='GET'){
        if(!user){json(res,401,{error:'Sessão expirada. Entre novamente.'});return;}json(res,200,{user:publicUser(user)});return;
      }
      if(!user){json(res,401,{error:'Faça login novamente.'});return;}
      if(url.pathname==='/api/logout' && req.method==='POST'){store.sessions=store.sessions.filter(s=>s.token_hash!==tokenHash(auth));persist();json(res,200,{ok:true});return;}
      if(url.pathname==='/api/profile' && req.method==='POST'){
        const points=Math.max(0,Math.min(1000000000,Math.floor(Number(data.points)||0)));
        const wins=Math.max(0,Math.min(10000000,Math.floor(Number(data.wins)||0)));
        // Client-reported scores are capped; economy-changing transactions must be server-validated in production.
        updateUser(user.id,{points:Math.max(user.points,points),wins:Math.max(user.wins,wins)});
        json(res,200,{user:publicUser(store.users.find(u=>u.id===user.id))});return;
      }
      if(url.pathname==='/api/777' && req.method==='POST'){
        if(!user){json(res,401,{error:'Faça login novamente.'});return;}
        const question=String(data.question||'').trim().slice(0,500);
        if(String(data.passcode||'')!=='777'){json(res,403,{error:'A senha não abriu o portal.'});return;}
        if(question.length<3){json(res,400,{error:'Escreva uma pergunta para o gnomo.'});return;}
        const nowMs=Date.now();
        if(Number(user.secret777_at)>0 && nowMs-Number(user.secret777_at)<24*60*60*1000){const next=Number(user.secret777_at)+24*60*60*1000;json(res,429,{error:'O portal já respondeu sua pergunta. Volte após 24 horas.',nextAt:next});return;}
        // Uma consulta diária por conta; resposta e saldo são decididos no servidor e persistidos.
        const positive=Math.random()<0.5;
        const gain=positive?250:150;
        const answer=positive
          ? ['O gnomo fareja bons ventos no seu caminho. Dê o próximo passo com coragem, mas mantenha os olhos abertos.','As folhas antigas sussurram um sim. A sorte favorece quem age com calma e intenção.','Uma pequena porta se abre diante de você. Aproveite a oportunidade sem esquecer seus aliados.'][crypto.randomInt(0,3)]
          : ['O gnomo ouviu sua pergunta, mas a névoa ainda cobre o caminho. Espere, observe e não force a resposta.','Hoje as estrelas pedem cautela. Nem todo não é derrota; às vezes é um desvio que protege você.','O vento virou contra a sua vela. Guarde energia, aprenda com os sinais e tente novamente amanhã.'][crypto.randomInt(0,3)];
        const before=Math.max(0,Number(user.credits)||0);
        const after=positive?Math.min(1000000000,before+gain):Math.max(0,before-gain);
        updateUser(user.id,{credits:after,secret777_at:nowMs});
        store.transactions.push({id:crypto.randomUUID(),user_id:user.id,kind:'secret777',amount:after-before,note:'Oráculo 777',created_at:new Date().toISOString()});persist();
        json(res,200,{answer,positive,delta:after-before,credits:after,nextAt:Date.now()+24*60*60*1000});return;
      }
      if(url.pathname==='/api/ranking' && req.method==='GET'){
        const players=[...store.users].sort((a,b)=>b.points-a.points||b.wins-a.wins).slice(0,100).map(u=>({username:u.username,points:u.points,credits:u.credits,wins:u.wins}));
        json(res,200,{players});return;
      }
      json(res,404,{error:'Rota não encontrada.'});
    });
    return;
  }
  res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});res.end('Not found');
});
// PeerJS signaling is self-hosted on the same service; the game data can still use WebRTC directly.
PeerServer({ server, path: '/peerjs', allow_discovery: false });
const wss = new WebSocketServer({ server, path: '/presence', maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  // Optional origin restriction. Set SITE_ORIGIN to the deployed Netlify URL.
  const allowedOrigin = process.env.SITE_ORIGIN;
  const origin = req.headers.origin;
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  clients.set(ws, { authenticated: false, name: '', peerId: '', roomCode: '', points: 0, wins: 0, credits: 100 });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { send(ws, { type: 'error', message: 'Mensagem inválida.' }); return; }
    if (!msg || typeof msg.type !== 'string') return;
    const session = clients.get(ws);
    if (!session) return;

    if (msg.type === 'login') {
      if (session.authenticated) { send(ws, { type: 'login-error', message: 'Esta conexão já tem um nick reservado.' }); return; }
      const account = getUserByToken(msg.token);
      if (!account) { send(ws, { type: 'login-error', message: 'Sessão inválida. Entre com sua conta novamente.' }); return; }
      const name = account.username;
      const key = nickKey(name);
      const occupied = nicknames.get(key);
      if (occupied && occupied !== ws) { send(ws, { type: 'login-error', message: 'Esse nick já está em uso por alguém online. Escolha outro.' }); return; }
      session.authenticated = true;
      session.name = name;
      session.userId = account.id;
      session.accountToken = msg.token;
      session.points = account.points; session.wins = account.wins; session.credits = account.credits;
      nicknames.set(key, ws);
      send(ws, { type: 'login-ok', name, onlineCount: nicknames.size, players: onlinePlayers() });
      broadcastPresence();
      return;
    }

    if (!session.authenticated) { send(ws, { type: 'error', message: 'Entre com um nick antes de usar o serviço.' }); return; }
    if (msg.type === 'logout') { removeClient(ws); try { ws.close(1000, 'logout'); } catch {} return; }
    if (msg.type === 'ping') { send(ws, { type: 'pong', at: Date.now() }); return; }
    if (msg.type === 'score-update') {
      session.points = Math.max(0, Math.min(100000000, Math.floor(Number(msg.points) || 0)));
      session.wins = Math.max(0, Math.min(1000000, Math.floor(Number(msg.wins) || 0)));
      session.credits = Math.max(0, Math.min(100000000, Math.floor(Number(msg.credits) || 0)));
      if(session.userId) { const account=store.users.find(u=>u.id===session.userId); if(account){account.points=Math.max(account.points,session.points);account.wins=Math.max(account.wins,session.wins);account.credits=session.credits;account.updated_at=new Date().toISOString();persist();} }
      broadcastPresence();
      return;
    }
    if (msg.type === 'room-register') {
      const code = String(msg.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
      const peerId = String(msg.peerId || '').trim().slice(0, 100);
      const stake = Number(msg.stake);
      if (!code || !peerId || ![5, 10, 25, 50, 100].includes(stake)) { send(ws, { type: 'room-error', message: 'Dados da sala inválidos.' }); return; }
      const existing = rooms.get(code);
      if (existing && existing.ws !== ws) { send(ws, { type: 'room-error', message: 'Esse código de sala já está registrado.' }); return; }
      rooms.set(code, { ws, peerId, stake, name: session.name, createdAt: Date.now() });
      session.roomCode = code;
      send(ws, { type: 'room-registered', code });
      return;
    }
    if (msg.type === 'room-unregister') {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (room && room.ws === ws) rooms.delete(code);
      if (session.roomCode === code) session.roomCode = '';
      return;
    }
    if (msg.type === 'queue-join') {
      removeFromQueue(ws);
      const peerId = String(msg.peerId || '').trim().slice(0, 100);
      const stake = Number(msg.stake);
      if (!peerId || ![5, 10, 25, 50, 100].includes(stake)) { send(ws, { type: 'queue-error', message: 'Código de conexão ou valor de mesa inválido.' }); return; }
      queue.push({ ws, peerId, stake, name: session.name, joinedAt: Date.now() });
      send(ws, { type: 'queue-waiting', onlineCount: nicknames.size });
      tryMatch();
      return;
    }
    if (msg.type === 'queue-leave') { removeFromQueue(ws); return; }
  });
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch {} }
  }
  // Remove abandoned queue entries after 3 minutes.
  const cutoff = Date.now() - 3 * 60 * 1000;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].joinedAt < cutoff || queue[i].ws.readyState !== WebSocket.OPEN) queue.splice(i, 1);
}, 30000);
server.on('close', () => clearInterval(heartbeat));
server.listen(PORT, HOST, () => console.log(`Pixzin presence server listening on ${HOST}:${PORT}`));
