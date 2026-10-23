const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const { client_secret, client_id } = credentials.installed || credentials.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  'http://localhost:3500'
);

const server = http.createServer(async (req, res) => {
  try {
    const queryParams = new url.URL(req.url, 'http://localhost:3500').searchParams;
    const code = queryParams.get('code');
    const error = queryParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2 style="color:red; text-align:center; padding:40px;">خطأ: ${error}</h2>`);
      console.error('AUTH_ERROR:', error);
      server.close();
      process.exit(1);
    }

    if (code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="text-align:center; padding:50px; font-family:sans-serif; direction:rtl;">
          <h1 style="color:#10b981;">🎉 تم ربط حساب Gmail بنجاح تام!</h1>
          <p style="font-size:18px; color:#374151;">تم استلام رمز التفعيل وحفظه. يمكنك إغلاق هذه الصفحة الآن.</p>
        </div>
      `);

      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(path.join(__dirname, 'token.json'), JSON.stringify(tokens, null, 2));
      console.log('TOKEN_SAVED_SUCCESSFULLY');
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);
    }
  } catch (err) {
    console.error('SERVER_ERROR:', err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('خطأ: ' + err.message);
  }
});

server.listen(3500, () => {
  console.log('LISTENING_ON_3500');
});
