const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * تحليل الرسالة البريدية بالذكاء الاصطناعي:
 * - استخراج اسم المرسل والشركة
 * - تحديد اللغة الأصلية والترجمة إلى العربية
 * - فهم المحتوى وكتابة ملخص دقيق
 * - استخراج أهم النقاط
 * - تحديد هل تحتاج إلى إجراء وما هو المطلوب
 * - تحديد الأولوية (عاجل، مهم، عادي، معلومات فقط)
 */
async function analyzeEmail({ from, subject, body, snippet }) {
  const contentToAnalyze = (body && body.trim().length > 20) ? body.substring(0, 5000) : snippet;

  const prompt = `
أنت وكيل ذكاء اصطناعي خبير ومسؤول عن إدارة وتحليل رسائل البريد الإلكتروني للمستخدم بدقة فائقة.
قم بتحليل بيانات البريد التالية:

- المرسل (From header): ${from || 'غير معروف'}
- العنوان الأصلي (Subject): ${subject || '(بدون عنوان)'}
- محتوى الرسالة:
${contentToAnalyze || '(لا يوجد نص متوفر)'}

المطلوب إخراج النتيجة بتنسيق JSON حصراً بهذا الشكل الدقيق:
{
  "sender_name": "اسم الشخص أو الجهة المرسلة بوضوح",
  "company": "اسم الشركة أو المؤسسة أو المنصة (مثال: Google, Workable, LinkedIn, جامعة كذا، إلخ. إذا لم تكن جهة اكتب: غير محدد)",
  "original_language": "اسم اللغة الأصلية للرسالة بالعربية (مثال: الإنجليزية، العربية، الفرنسية)",
  "translated_body": "ترجمة عربية وافية واحترافية لمحتوى الرسالة (إذا كانت الرسالة أصلية بالعربية، ضع النص كما هو مع تصحيح بسيط إن لزم)",
  "summary": "ملخص ذكي وواضح جداً بالعربية يوضح جوهر الرسالة في سطرين أو ثلاثة",
  "key_points": [
    "النقطة الأولى المهمة",
    "النقطة الثانية المهمة",
    "النقطة الثالثة إن وجدت"
  ],
  "action_required": true, // ضع true إذا كانت الرسالة تتطلب من المستخدم رداً أو موعداً أو اتخاذ إجراء ما، و false إذا كانت مجرد إشعار أو تقرير للعلم
  "action_details": "ما المطلوب من المستخدم بالتحديد (إذا لم يكن هناك إجراء، اكتب: للعلم فقط - لا يتطلب إجراء)",
  "priority": "عاجل" // اختر قيمة واحدة فقط من بين: ["عاجل", "مهم", "عادي", "معلومات فقط"] بناءً على حساسية الوقت وأهمية الموضوع
}

ملاحظات هامة:
- تصنيف الأولوية:
  * "عاجل": مقابلات عمل محددة بموعد قريب، تحذيرات أمنية خطيرة، عروض وطلبات تتطلب رداً فورياً اليوم.
  * "مهم": تحديثات وظيفية، فواتير، رسائل رسمية من جهات عمل أو عملاء مهمين.
  * "عادي": رسائل إخبارية مقصودة، تحديثات دورية عادية.
  * "معلومات فقط": رسائل دعائية، إشعارات تلقائية لا تحتاج أي تفاعل.
- أجب فقط بكود JSON الصالح بدون أي مقدمات أو علامات إضافية.
`;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const rawText = response.text.trim();
      const parsed = JSON.parse(rawText);

      return {
        sender_name: parsed.sender_name || from,
        company: parsed.company || 'غير محدد',
        original_language: parsed.original_language || 'غير معروف',
        translated_body: parsed.translated_body || body,
        summary: parsed.summary || snippet,
        key_points: Array.isArray(parsed.key_points) ? parsed.key_points : [],
        action_required: Boolean(parsed.action_required),
        action_details: parsed.action_details || 'لا يتطلب إجراء',
        priority: ['عاجل', 'مهم', 'عادي', 'معلومات فقط'].includes(parsed.priority) ? parsed.priority : 'عادي'
      };
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        // انتظار ثانية واحدة قبل إعادة المحاولة
        await new Promise(res => setTimeout(res, 1200));
      }
    }
  }

  console.error('خطأ أثناء تحليل الرسالة بالذكاء الاصطناعي:', lastError?.message || lastError);
    // في حال حدوث أي خطأ، نعيد تحليلاً افتراضياً آمناً دون إسقاط النظام
    return {
      sender_name: from,
      company: 'غير محدد',
      original_language: 'غير معروف',
      translated_body: body || snippet,
      summary: snippet || '(تعذر التلخيص التلقائي)',
      key_points: ['تعذر استخراج النقاط تلقائياً'],
      action_required: false,
      action_details: 'يرجى مراجعة الرسالة الأصلية',
      priority: 'عادي'
  };
}

module.exports = {
  analyzeEmail
};
