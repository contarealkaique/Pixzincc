'use strict';
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { PeerServer } = require('peer');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');


const DATA_DIR = process.env.DATA_DIR || '/var/data';
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(process.env.DB_PATH || `${DATA_DIR}/pixzin.sqlite`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, credits INTEGER NOT NULL DEFAULT 1000,
 wins INTEGER NOT NULL DEFAULT 0, inventory TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const publicUser = u => ({ id:u.id, username:u.username, points:u.points, credits:u.credits, wins:u.wins, inventory:JSON.parse(u.inventory || '[]'), createdAt:u.created_at });
function getUserByToken(token) {
 if (!token || typeof token !== 'string' || token.length > 200) return null;
 const row=db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token),Date.now());
 return row || null;
}
function issueToken(userId) {
 const token=crypto.randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token),userId,Date.now()+1000*60*60*24*30);
 return token;
}
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
    json(res,200,{service:'pixzin-vegas',status:'ok',database:'sqlite',online:nicknames.size,waiting:queue.length}); return;
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
        if(db.prepare('SELECT id FROM users WHERE username_key=?').get(key)){json(res,409,{error:'Esse nome de usuário já existe. Faça login ou escolha outro.'});return;}
        const id=crypto.randomUUID(), hash=bcrypt.hashSync(data.password,12);
        try { db.prepare('INSERT INTO users(id,username,username_key,password_hash) VALUES(?,?,?,?)').run(id,username,key,hash); db.prepare('INSERT INTO transactions(user_id,kind,amount,note) VALUES(?,?,?,?)').run(id,'welcome',1000,'Saldo inicial'); }
        catch(e){json(res,409,{error:'Não foi possível criar a conta. Tente outro nome.'});return;}
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(id);json(res,201,{token:issueToken(id),user:publicUser(user)});return;
      }
      if(req.method==='POST' && url.pathname==='/api/login'){
        const user=db.prepare('SELECT * FROM users WHERE username_key=?').get(key);
        if(!user || typeof data.password!=='string' || !bcrypt.compareSync(data.password,user.password_hash)){json(res,401,{error:'Usuário ou senha incorretos.'});return;}
        json(res,200,{token:issueToken(user.id),user:publicUser(user)});return;
      }
      const auth=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
      const user=getUserByToken(auth);
      if(url.pathname==='/api/me' && req.method==='GET'){
        if(!user){json(res,401,{error:'Sessão expirada. Entre novamente.'});return;}json(res,200,{user:publicUser(user)});return;
      }
      if(!user){json(res,401,{error:'Faça login novamente.'});return;}
      if(url.pathname==='/api/logout' && req.method==='POST'){db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(auth));json(res,200,{ok:true});return;}
      if(url.pathname==='/api/profile' && req.method==='POST'){
        const points=Math.max(0,Math.min(1000000000,Math.floor(Number(data.points)||0)));
        const wins=Math.max(0,Math.min(10000000,Math.floor(Number(data.wins)||0)));
        // Client-reported scores are capped; economy-changing transactions must be server-validated in production.
        db.prepare('UPDATE users SET points=MAX(points,?), wins=MAX(wins,?), updated_at=CURRENT_TIMESTAMP WHERE id=?').run(points,wins,user.id);
        json(res,200,{user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))});return;
      }
      if(url.pathname==='/api/ranking' && req.method==='GET'){
        const players=db.prepare('SELECT username,points,credits,wins FROM users ORDER BY points DESC,wins DESC LIMIT 100').all();
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
      if(session.userId) db.prepare('UPDATE users SET points=MAX(points,?), wins=MAX(wins,?), credits=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.points,session.wins,session.credits,session.userId);
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
