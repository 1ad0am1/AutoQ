const { neon } = require('@neondatabase/serverless');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const STATUS = ['جديد','قيد المراجعة','تم التأكيد','تم الشحن','مكتمل','ملغي'];
const CATEGORIES = ['german','japan','korea','china','oils'];

const cleanPhone = v => String(v || '').replace(/\D/g,'');
const sign = (p, exp='7d') => jwt.sign(p, JWT_SECRET, {expiresIn:exp});
const send = (res, code, body) => res.status(code).json(body);

function config(res){
  if(!process.env.DATABASE_URL && !process.env.POSTGRES_URL)
    return send(res,500,{error:'DATABASE_URL غير مضبوط في Vercel.'});
  if(!JWT_SECRET) return send(res,500,{error:'JWT_SECRET غير مضبوط في Vercel.'});
  return true;
}
function bearer(req){
  const h=req.headers.authorization||'';
  return h.startsWith('Bearer ')?h.slice(7):'';
}
function auth(req,res,role){
  try{
    const u=jwt.verify(bearer(req),JWT_SECRET);
    if(role && u.role!==role) return {error:send(res,403,{error:'غير مصرح'})};
    return {user:u};
  }catch{return {error:send(res,401,{error:'انتهت الجلسة أو رمز الدخول غير صحيح'})};}
}
function userOut(r){return {id:r.id,name:r.name,phone:r.phone,country:r.country,address:r.address,created:r.created,avatar:r.avatar||''};}
function orderOut(r){
  return {...r,user_id:undefined,items:JSON.parse(r.items_json||'[]'),history:JSON.parse(r.history_json||'[]')};
}
function productOut(r){
  let images=[]; try{images=JSON.parse(r.images||'[]')}catch{} if(!Array.isArray(images)||!images.length) images=r.image?[r.image]:[]; return {id:r.id,name:r.name,category:r.category,brand:r.brand||'',model:r.model||'',part_number:r.part_number||'',price:Number(r.price||0),stock:Number(r.stock||0),image:r.image||images[0]||'',images,description:r.description||'',active:r.active!==false,created:r.created,updated:r.updated};
}

async function initDb(){
  await sql`CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL DEFAULT 'مصر',
    address TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT ''`;

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

  await sql`CREATE TABLE IF NOT EXISTS products(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    part_number TEXT NOT NULL DEFAULT '',
    price NUMERIC(12,2) NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT NOT NULL DEFAULT '[]'`;
}

module.exports = async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');
    return res.status(204).end();
  }
  if(!config(res)) return;

  try{
    await initDb();
    const path=(req.url||'').split('?')[0].replace(/\/+/g,'/').replace(/\/$/,'')||'/';

    if(req.method==='GET' && path==='/api/health')
      return send(res,200,{ok:true,service:'AutoQ API',database:'Neon'});

    if(req.method==='POST' && path==='/api/auth/register'){
      const {name,phone,country,address}=req.body||{};
      const p=cleanPhone(phone);
      if(!name||!p||!address) return send(res,400,{error:'الاسم والهاتف والعنوان مطلوبون'});
      if(p.length<8) return send(res,400,{error:'رقم الهاتف غير صحيح'});
      const exists=await sql`SELECT id FROM users WHERE phone=${p} LIMIT 1`;
      if(exists.length) return send(res,409,{error:'هذا الرقم مسجل بالفعل'});
      const rows=await sql`INSERT INTO users(name,phone,country,address) VALUES(${String(name).trim()},${p},${country||'مصر'},${String(address).trim()}) RETURNING *`;
      const u=userOut(rows[0]);
      return send(res,201,{user:u,token:sign({id:u.id,phone:u.phone,role:'customer'})});
    }

    if(req.method==='POST' && path==='/api/auth/login'){
      const p=cleanPhone(req.body?.phone);
      const rows=await sql`SELECT * FROM users WHERE phone=${p} LIMIT 1`;
      if(!rows.length) return send(res,401,{error:'الحساب غير موجود'});
      const u=userOut(rows[0]);
      return send(res,200,{user:u,token:sign({id:u.id,phone:u.phone,role:'customer'})});
    }

    if(req.method==='GET' && path==='/api/me'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const rows=await sql`SELECT * FROM users WHERE id=${a.user.id} LIMIT 1`;
      if(!rows.length)return send(res,404,{error:'المستخدم غير موجود'});
      return send(res,200,{user:userOut(rows[0])});
    }

    if(req.method==='PATCH' && path==='/api/me'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const {name,country,address,avatar}=req.body||{};
      const rows=await sql`UPDATE users SET
        name=COALESCE(${name===undefined?null:String(name).trim()},name),
        country=COALESCE(${country===undefined?null:String(country)},country),
        address=COALESCE(${address===undefined?null:String(address).trim()},address),
        avatar=COALESCE(${avatar===undefined?null:String(avatar)},avatar)
        WHERE id=${a.user.id} RETURNING *`;
      if(!rows.length)return send(res,404,{error:'المستخدم غير موجود'});
      return send(res,200,{user:userOut(rows[0])});
    }

    if(req.method==='POST' && path==='/api/orders'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const users=await sql`SELECT * FROM users WHERE id=${a.user.id} LIMIT 1`;
      if(!users.length)return send(res,404,{error:'المستخدم غير موجود'});
      const items=Array.isArray(req.body?.items)?req.body.items:[];
      const total=Number(req.body?.total||0);
      if(!items.length||!Number.isFinite(total)||total<0)return send(res,400,{error:'بيانات الطلب غير صحيحة'});
      const id='AQ-'+Date.now();
      const u=users[0], now=new Date().toISOString(), history=[{status:'جديد',date:now}];
      const rows=await sql`INSERT INTO orders(id,user_id,customer,phone,address,items_json,total,status,created,updated,history_json)
        VALUES(${id},${u.id},${u.name},${u.phone},${u.address},${JSON.stringify(items)},${total},'جديد',NOW(),NOW(),${JSON.stringify(history)}) RETURNING *`;
      return send(res,201,{order:orderOut(rows[0])});
    }

    if(req.method==='GET' && path==='/api/orders/my'){
      const a=auth(req,res,'customer'); if(a.error)return;
      const rows=await sql`SELECT * FROM orders WHERE user_id=${a.user.id} ORDER BY created DESC`;
      return send(res,200,{orders:rows.map(orderOut)});
    }

    if(req.method==='POST' && path==='/api/admin/login'){
      const {email,password}=req.body||{};
      if(!ADMIN_EMAIL||!ADMIN_PASSWORD)return send(res,500,{error:'بيانات الأدمن غير مضبوطة في Vercel.'});
      if(email!==ADMIN_EMAIL||password!==ADMIN_PASSWORD)return send(res,401,{error:'بيانات الأدمن غير صحيحة'});
      return send(res,200,{token:sign({role:'admin',email},'12h')});
    }

    if(req.method==='GET' && path==='/api/admin/orders'){
      const a=auth(req,res,'admin'); if(a.error)return;
      const rows=await sql`SELECT * FROM orders ORDER BY created DESC`;
      return send(res,200,{orders:rows.map(orderOut)});
    }

    if(req.method==='GET' && path==='/api/admin/users'){
      const a=auth(req,res,'admin'); if(a.error)return;
      const rows=await sql`SELECT * FROM users ORDER BY created DESC`;
      return send(res,200,{users:rows.map(userOut)});
    }

    const orderMatch=path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(req.method==='PATCH' && orderMatch){
      const a=auth(req,res,'admin'); if(a.error)return;
      const id=decodeURIComponent(orderMatch[1]), status=req.body?.status;
      if(!STATUS.includes(status))return send(res,400,{error:'حالة غير صحيحة'});
      const old=await sql`SELECT * FROM orders WHERE id=${id} LIMIT 1`;
      if(!old.length)return send(res,404,{error:'الطلب غير موجود'});
      const o=old[0], history=JSON.parse(o.history_json||'[]'), now=new Date().toISOString();
      if(status!==o.status)history.push({status,date:now});
      const rows=await sql`UPDATE orders SET status=${status},updated=NOW(),history_json=${JSON.stringify(history)} WHERE id=${id} RETURNING *`;
      return send(res,200,{order:orderOut(rows[0])});
    }

    if(req.method==='GET' && path==='/api/products'){
      const rows=await sql`SELECT * FROM products WHERE active=TRUE ORDER BY created DESC`;
      return send(res,200,{products:rows.map(productOut)});
    }

    if(req.method==='GET' && path==='/api/admin/products'){
      const a=auth(req,res,'admin'); if(a.error)return;
      const rows=await sql`SELECT * FROM products ORDER BY created DESC`;
      return send(res,200,{products:rows.map(productOut)});
    }

    if((req.method==='POST'||req.method==='PUT') && path==='/api/admin/products'){
      const a=auth(req,res,'admin'); if(a.error)return;
      const b=req.body||{}, id=String(b.id||('P-'+Date.now()));
      const name=String(b.name||'').trim(), category=String(b.category||'');
      const price=Number(b.price||0), stock=Math.max(0,Math.floor(Number(b.stock||0)));
      let images=Array.isArray(b.images)?b.images.filter(x=>typeof x==='string'&&x.trim()).slice(0,6):[];
      if(!images.length && b.image) images=[String(b.image)];
      if(images.some(x=>x.length>700000)||JSON.stringify(images).length>3900000)
        return send(res,400,{error:'حجم الصور كبير جدًا. اختر صورًا أصغر أو صورًا أقل.'});
      const image=images[0]||'', imagesJson=JSON.stringify(images);
      if(!name||!CATEGORIES.includes(category)||!Number.isFinite(price)||price<0)
        return send(res,400,{error:'بيانات المنتج غير صحيحة'});
      const rows=await sql`INSERT INTO products(id,name,category,brand,model,part_number,price,stock,image,images,description,active,created,updated)
        VALUES(${id},${name},${category},${String(b.brand||'')},${String(b.model||'')},${String(b.part_number||'')},${price},${stock},${image},${imagesJson},${String(b.description||'')},${b.active!==false},NOW(),NOW())
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,brand=EXCLUDED.brand,model=EXCLUDED.model,part_number=EXCLUDED.part_number,price=EXCLUDED.price,stock=EXCLUDED.stock,image=EXCLUDED.image,images=EXCLUDED.images,description=EXCLUDED.description,active=EXCLUDED.active,updated=NOW()
        RETURNING *`;
      return send(res,200,{product:productOut(rows[0])});
    }

    const productMatch=path.match(/^\/api\/admin\/products\/([^/]+)$/);
    if((req.method==='PATCH'||req.method==='PUT') && productMatch){
      const a=auth(req,res,'admin'); if(a.error)return;
      const id=decodeURIComponent(productMatch[1]), b=req.body||{};
      const old=await sql`SELECT * FROM products WHERE id=${id} LIMIT 1`;
      if(!old.length)return send(res,404,{error:'المنتج غير موجود'});
      const p=old[0];
      const name=b.name===undefined?p.name:String(b.name).trim();
      const category=b.category===undefined?p.category:String(b.category);
      const price=b.price===undefined?Number(p.price):Number(b.price);
      const stock=b.stock===undefined?Number(p.stock):Math.max(0,Math.floor(Number(b.stock)));
      let images; if(Array.isArray(b.images)) images=b.images.filter(x=>typeof x==='string'&&x.trim()).slice(0,6); else {try{images=JSON.parse(p.images||'[]')}catch{images=p.image?[p.image]:[]}};
      if(!images.length && b.image) images=[String(b.image)];
      if(images.some(x=>x.length>700000)||JSON.stringify(images).length>3900000)return send(res,400,{error:'حجم الصور كبير جدًا'});
      const image=images[0]||'', imagesJson=JSON.stringify(images);
      if(!name||!CATEGORIES.includes(category)||!Number.isFinite(price)||price<0)return send(res,400,{error:'بيانات المنتج غير صحيحة'});
      const rows=await sql`UPDATE products SET name=${name},category=${category},brand=${b.brand===undefined?p.brand:String(b.brand)},model=${b.model===undefined?p.model:String(b.model)},part_number=${b.part_number===undefined?p.part_number:String(b.part_number)},price=${price},stock=${stock},image=${image},images=${imagesJson},description=${b.description===undefined?p.description:String(b.description)},active=${b.active===undefined?p.active:!!b.active},updated=NOW() WHERE id=${id} RETURNING *`;
      return send(res,200,{product:productOut(rows[0])});
    }

    if(req.method==='DELETE' && productMatch){
      const a=auth(req,res,'admin'); if(a.error)return;
      const id=decodeURIComponent(productMatch[1]);
      const rows=await sql`DELETE FROM products WHERE id=${id} RETURNING id`;
      if(!rows.length)return send(res,404,{error:'المنتج غير موجود'});
      return send(res,200,{ok:true});
    }

    return send(res,404,{error:'المسار غير موجود'});
  }catch(e){
    console.error(e);
    return send(res,500,{error:'حدث خطأ في خادم AutoQ',detail:process.env.NODE_ENV==='development'?e.message:undefined});
  }
};
