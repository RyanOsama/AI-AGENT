const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const { client_secret, client_id } = credentials.installed || credentials.web;

// منفذ 3500 محلي
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  'http://localhost:3500'
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify'
  ],
  prompt: 'consent'
});

fs.writeFileSync(path.join(__dirname, 'auth_url.txt'), authUrl);
console.log('AUTH_URL_READY');
