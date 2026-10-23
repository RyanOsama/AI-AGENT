const { google } = require('googleapis');
const { authorize } = require('./auth');
const db = require('./database');
const { analyzeEmail } = require('./analyzer');

// فك تشفير محتوى الرسالة من Gmail (Base64url)
function decodeBase64(data) {
  if (!data) return '';
  const sanitized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(sanitized, 'base64').toString('utf8');
}

// استخراج النص الكامل من أجزاء الرسالة (Plain text أو HTML)
function extractBody(payload) {
  if (!payload) return '';
  
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }

  if (payload.parts && payload.parts.length > 0) {
    // نبحث أولاً عن text/plain
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart && textPart.body && textPart.body.data) {
      return decodeBase64(textPart.body.data);
    }
    
    // إذا لم يتوفر، نبحث عن text/html وننزع وسوم HTML البسيطة
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart && htmlPart.body && htmlPart.body.data) {
      const html = decodeBase64(htmlPart.body.data);
      return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                 .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\s+/g, ' ')
                 .trim();
    }

    // إذا كانت متداخلة (Nested parts)
    for (const part of payload.parts) {
      const subBody = extractBody(part);
      if (subBody) return subBody;
    }
  }

  return '';
}

// الدالة الرئيسية لفحص ومعالجة الرسائل الجديدة
async function processNewEmails(maxEmails = 10) {
  try {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    // جلب أحدث الرسائل
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: maxEmails
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      await db.logEvent('INFO', 'فحص البريد مكتمل: لا توجد رسائل جديدة');
      return { processedCount: 0, newEmails: [] };
    }

    const processedList = [];

    for (const messageMeta of messages) {
      const messageId = messageMeta.id;

      // 1. التحقق من قاعدة البيانات لمنع التكرار
      const alreadyProcessed = await db.isMessageProcessed(messageId);
      if (alreadyProcessed) {
        continue; // تم معالجتها سابقاً، نتخطاها
      }

      console.log(`[+] جاري معالجة رسالة جديدة: ${messageId}`);

      // 2. جلب تفاصيل الرسالة
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });

      const payload = msgRes.data.payload || {};
      const headers = payload.headers || [];

      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(بدون عنوان)';
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const snippet = msgRes.data.snippet || '';

      // استخراج محتوى النص
      const fullBody = extractBody(payload) || snippet;

      // استخراج البريد والاسم من ترويسة From
      let senderName = fromHeader;
      let senderEmail = fromHeader;
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      if (emailMatch) {
        senderEmail = emailMatch[1];
        senderName = fromHeader.replace(/<[^>]+>/, '').replace(/["']/g, '').trim() || senderEmail;
      }

      // 3. تحليل الرسالة بالذكاء الاصطناعي
      const aiAnalysis = await analyzeEmail({
        from: senderName,
        subject: subject,
        body: fullBody,
        snippet: snippet
      });

      // 4. حفظ البيانات في SQLite
      const emailRecord = {
        message_id: messageId,
        thread_id: msgRes.data.threadId,
        sender_name: aiAnalysis.sender_name || senderName,
        sender_email: senderEmail,
        company: aiAnalysis.company || 'غير محدد',
        subject: subject,
        date: dateHeader,
        timestamp: new Date(dateHeader).getTime() || Date.now(),
        original_language: aiAnalysis.original_language,
        body_snippet: snippet,
        translated_body: aiAnalysis.translated_body,
        summary: aiAnalysis.summary,
        key_points: aiAnalysis.key_points,
        action_required: aiAnalysis.action_required,
        action_details: aiAnalysis.action_details,
        priority: aiAnalysis.priority,
        gmail_link: `https://mail.google.com/mail/u/0/#inbox/${messageId}`
      };

      await db.saveEmail(emailRecord);
      processedList.push(emailRecord);

      await db.logEvent('INFO', `تمت معالجة البريد بنجاح: ${subject}`, {
        priority: emailRecord.priority,
        company: emailRecord.company
      });
    }

    return {
      processedCount: processedList.length,
      newEmails: processedList
    };
  } catch (error) {
    console.error('خطأ في دورة فحص البريد:', error);
    await db.logEvent('ERROR', 'فشل في فحص البريد الإلكتروني', error.message);
    throw error;
  }
}

module.exports = {
  processNewEmails
};
