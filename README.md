# AutoQ — نسخة Vercel الكاملة

هذه النسخة مصممة للعمل على **Vercel** فقط، بدون Render.

## الملفات
- `index.html` الموقع الرئيسي.
- `admin.html` لوحة الأدمن.
- `api-config.js` يربط الواجهة تلقائيًا بنفس دومين Vercel.
- `api/index.js` Backend Serverless على Vercel.
- `package.json` dependencies.
- `vercel.json` إعدادات Vercel.
- `.env.example` أسماء متغيرات البيئة فقط.

## قاعدة البيانات
استخدم قاعدة PostgreSQL من Neon (يمكن إنشاؤها من Vercel Marketplace) ثم ضع Connection String في متغير `DATABASE_URL` أو `POSTGRES_URL`.

المتغيرات المطلوبة في Vercel:
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

## النشر
1. ارفع محتويات هذا المجلد إلى GitHub Repository.
2. في Vercel اختر **Add New → Project** ثم اختر Repository.
3. اترك Root Directory هو جذر المشروع.
4. Deploy.
5. من Vercel → Project → Settings → Environment Variables أضف المتغيرات الأربعة.
6. اعمل Redeploy.
7. اختبر: `https://YOUR-DOMAIN.vercel.app/api/health` ويجب أن يظهر `ok: true`.
8. افتح `https://YOUR-DOMAIN.vercel.app/admin.html` لتسجيل دخول الأدمن.

## الأمان
- لا تضع `DATABASE_URL` أو `JWT_SECRET` أو كلمة مرور الأدمن داخل GitHub.
- رقم الهاتف Unique في قاعدة البيانات.
- الشراء لا يتم إلا بعد تسجيل دخول العميل.
- الطلبات تحفظ في PostgreSQL وتظهر للأدمن من أي جهاز.
- لا يوجد OTP في النسخة الحالية؛ التسجيل وتسجيل الدخول يتمان مباشرة برقم الهاتف، مع منع تكرار الرقم.
