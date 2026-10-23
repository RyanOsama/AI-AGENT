const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { google } = require('googleapis');
require('dotenv').config();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

function getCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error('لم يتم العثور على credentials.json في مجلد المشروع.');
  }
  const content = fs.readFileSync(CREDENTIALS_PATH);
  return JSON.parse(content);
}

function getOAuth2Client() {
  const credentials = getCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  
  // نستخدم منفذ محلي محدد للـ redirect
  const redirectUri = 'http://localhost:3500';
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

async function authorize() {
  const oAuth2Client = getOAuth2Client();

  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    console.log('\n======================================================');
    console.log('مطلوب تسجيل الدخول بحساب Gmail للمرة الأولى فقط:');
    console.log('افتح الرابط التالي في المتصفح وسجل الدخول:');
    console.log(authUrl);
    console.log('======================================================\n');

    // تشغيل خادم مؤقت لاستقبال كود التفعيل تلقائياً
    const server = http.createServer(async (req, res) => {
      try {
        const queryParams = new url.URL(req.url, 'http://localhost:3500').searchParams;
        const code = queryParams.get('code');

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <div style="text-align:center; padding:50px; font-family:sans-serif;">
              <h1 style="color:#10b981;">🎉 تم ربط حساب Gmail بنجاح!</h1>
              <p>يمكنك الآن إغلاق هذه الصفحة والعودة للبرنامج.</p>
            </div>
          `);

          server.close();

          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
          console.log('\n✅ تم حفظ ملف المصادقة token.json بنجاح!');
          resolve(oAuth2Client);
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3>حدث خطأ أثناء المصادقة: ' + e.message + '</h3>');
        reject(e);
      }
    });

    server.listen(3500, () => {
      console.log('الخادم في انتظار تسجيل الدخول عبر المتصفح (Port: 3500)...');
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = {
  authorize,
  getOAuth2Client
};
