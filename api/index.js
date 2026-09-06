const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const ALLOWED_STATUS = ['جديد','قيد المراجعة','تم التأكيد','تم الشحن','مكتمل','ملغي'];

function cleanPhone(value){ return String(value || '').replace(/\D/g,''); }
function sign(payload, expires='7d'){ return jwt.sign(payload, JWT_SECRET, {expiresIn: expires}); }
function json(res, status, body){ res.status(status).json(body); }
function requireConfig(res){
  if(!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return json(res,500,{error:'DATABASE_URL غير مضبوط في Vercel.'});
  if(!JWT_SECRET) return json(res,500,{error:'JWT_SECRET غير مضبوط في Vercel.'});
  return true;
}
function getBearer(req){
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
function auth(req,res,role){
  try{
    const token=getBearer(req);
    if(!token) return {error:json(res,401,{error:'Unauthorized'})};
    const user=jwt.verify(token,JWT_SECRET);
    if(role && user.role!==role) return {error:json(res,403,{error: role==='admin'?'Admin only':'Customer only'})};
    return {user};
  }catch(e){ return {error:json(res,401,{error:'انتهت الجلسة أو رمز الدخول غير صحيح'})}; }
}

async function initDb(){
  await sql`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL DEFAULT 'مصر',
    address TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    customer TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT,
    items_json TEXT NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    status TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    history_json TEXT NOT NULL
  )`;
}
function userOut(r){return {id:r.id,name:r.name,phone:r.phone,country:r.country,address:r.address,created:r.created};}
function orderOut(r){
  return {...r, user_id:undefined, items:JSON.parse(r.items_json||'[]'), history:JSON.parse(r.history_json||'[]')};
}

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');return res.status(204).end();}
  if(!requireConfig(res)) return;
  try{
    await initDb();
    const path=(req.url||'').split('?')[0].replace(/\/+/g,'/').replace(/\/$/,'') || '/';

    if(req.method==='GET' && path==='/api/health') return json(res,200,{ok:true,service:'AutoQ API'});

    if(req.method==='POST' && path==='/api/auth/register'){
      const {name,phone,country,address}=req.body||{}; const p=cleanPhone(phone);
      if(!name||!p||!address) return json(res,400,{error:'الاسم والهاتف والعنوان مطلوبون'});
      if(p.length<8) return json(res,400,{error:'رقم الهاتف غير صحيح'});
      const exists=await sql`SELECT id FROM users WHERE phone=${p} LIMIT 1`;
      if(exists.length) return json(res,409,{error:'هذا الرقم مسجل بالفعل'});
      const rows=await sql`INSERT INTO users(name,phone,country,address) VALUES(${String(name).trim()},${p},${country||'مصر'},${String(address).trim()}) RETURNING *`;
      const u=userOut(rows[0]); return json(res,201,{user:u,token:sign({id:u.id,phone:u.phone,role:'customer'})});
    }

    if(req.method==='POST' && path==='/api/auth/login'){
      const p=cleanPhone(req.body?.phone); const rows=await sql`SELECT * FROM users WHERE phone=${p} LIMIT 1`;
      if(!rows.length) return json(res,401,{error:'الحساب غير موجود'});
      const u=userOut(rows[0]); return json(res,200,{user:u,token:sign({id:u.id,phone:u.phone,role:'customer'})});
    }

    if(req.method==='GET' && path==='/api/me'){
      const a=auth(req,res,'customer'); if(a.error)return; const rows=await sql`SELECT * FROM users WHERE id=${a.user.id} LIMIT 1`;
      if(!rows.length)return json(res,404,{error:'المستخدم غير موجود'}); return json(res,200,{user:userOut(rows[0])});
    }

    if(req.method==='PATCH' && path==='/api/me'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const name=String(req.body?.name||'').trim(); const country=String(req.body?.country||'مصر').trim(); const address=String(req.body?.address||'').trim();
      if(!name||!address)return json(res,400,{error:'الاسم والعنوان مطلوبان'});
      const rows=await sql`UPDATE users SET name=${name},country=${country||'مصر'},address=${address} WHERE id=${a.user.id} RETURNING *`;
      if(!rows.length)return json(res,404,{error:'المستخدم غير موجود'}); return json(res,200,{user:userOut(rows[0])});
    }

    if(req.method==='POST' && path==='/api/orders'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const users=await sql`SELECT * FROM users WHERE id=${a.user.id} LIMIT 1`; if(!users.length)return json(res,404,{error:'المستخدم غير موجود'});
      const items=Array.isArray(req.body?.items)?req.body.items:[]; const total=Number(req.body?.total||0);
      if(!items.length||!Number.isFinite(total)||total<0)return json(res,400,{error:'بيانات الطلب غير صحيحة'});
      const id='AQ-'+Date.now(); const u=users[0]; const now=new Date().toISOString(); const history=[{status:'جديد',date:now}];
      const rows=await sql`INSERT INTO orders(id,user_id,customer,phone,address,items_json,total,status,created,updated,history_json)
        VALUES(${id},${u.id},${u.name},${u.phone},${u.address},${JSON.stringify(items)},${total},'جديد',NOW(),NOW(),${JSON.stringify(history)}) RETURNING *`;
      return json(res,201,{order:orderOut(rows[0])});
    }

    if(req.method==='GET' && path==='/api/orders/my'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const rows=await sql`SELECT * FROM orders WHERE user_id=${a.user.id} ORDER BY created DESC`; return json(res,200,{orders:rows.map(orderOut)});
    }

    if(req.method==='POST' && path==='/api/admin/login'){
      const {email,password}=req.body||{};
      if(!ADMIN_EMAIL||!ADMIN_PASSWORD)return json(res,500,{error:'بيانات الأدمن غير مضبوطة في Vercel.'});
      if(email!==ADMIN_EMAIL||password!==ADMIN_PASSWORD)return json(res,401,{error:'بيانات الأدمن غير صحيحة'});
      return json(res,200,{token:sign({role:'admin',email},'12h')});
    }

    if(req.method==='GET' && path==='/api/admin/orders'){
      const a=auth(req,res,'admin'); if(a.error)return; const rows=await sql`SELECT * FROM orders ORDER BY created DESC`; return json(res,200,{orders:rows.map(orderOut)});
    }
    if(req.method==='GET' && path==='/api/admin/users'){
      const a=auth(req,res,'admin'); if(a.error)return; const rows=await sql`SELECT * FROM users ORDER BY created DESC`; return json(res,200,{users:rows.map(userOut)});
    }

    const match=path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(req.method==='PATCH' && match){
      const a=auth(req,res,'admin'); if(a.error)return; const id=decodeURIComponent(match[1]); const status=req.body?.status;
      if(!ALLOWED_STATUS.includes(status))return json(res,400,{error:'حالة غير صحيحة'});
      const old=await sql`SELECT * FROM orders WHERE id=${id} LIMIT 1`; if(!old.length)return json(res,404,{error:'الطلب غير موجود'});
      const o=old[0]; const history=JSON.parse(o.history_json||'[]'); const now=new Date().toISOString(); if(status!==o.status)history.push({status,date:now});
      const rows=await sql`UPDATE orders SET status=${status},updated=NOW(),history_json=${JSON.stringify(history)} WHERE id=${id} RETURNING *`;
      return json(res,200,{order:orderOut(rows[0])});
    }

    return json(res,404,{error:'المسار غير موجود'});
  }catch(e){
    console.error(e);
    return json(res,500,{error:'حدث خطأ في خادم AutoQ'});
  }
};
